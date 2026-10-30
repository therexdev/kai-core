"use strict";
(function (root) {
  function orderedIds(rows, preferred = []) {
    const available = new Set(rows.map(row => row.id)), seen = new Set(), ids = [];
    for (const id of [...(Array.isArray(preferred) ? preferred : []), ...available]) {
      if (available.has(id) && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
  }
  function moveId(ids, id, destination) {
    if (!ids.includes(id) || !Number.isInteger(destination)) return [...ids];
    const next = ids.filter(value => value !== id);
    next.splice(Math.max(0, Math.min(next.length, destination)), 0, id);
    return next;
  }
  // Serialize preference writes so a slow earlier drag cannot overwrite the
  // user's later choice. Failed writes restore the most recent saved order.
  function createOrder({ save, changed = () => {}, failed = () => {} }) {
    let rows = [], ids = [], saved = [], initialized = false, revision = 0, tail = Promise.resolve();
    return {
      sync(nextRows, preferred) {
        rows = nextRows;
        if (!initialized) { saved = orderedIds(rows, preferred); ids = [...saved]; initialized = true; }
        else { ids = orderedIds(rows, ids); saved = orderedIds(rows, saved); }
        return [...ids];
      },
      get() { return [...ids]; },
      set(next) {
        const wanted = orderedIds(rows, next);
        if (wanted.join("\n") === ids.join("\n")) return tail;
        ids = wanted; const generation = ++revision; changed();
        tail = tail.then(async () => {
          // An app can be removed while an earlier reorder is being saved.
          const requested = orderedIds(rows, wanted);
          try {
            const result = await save(requested);
            saved = orderedIds(rows, Array.isArray(result) ? result : result?.ids || requested);
            if (generation === revision) ids = [...saved];
          } catch (error) {
            if (generation === revision) ids = [...saved];
            failed(error);
          } finally { changed(); }
        });
        return tail;
      },
    };
  }
  function create({ document, bridge, open, manage, notify }) {
    const section = document.getElementById("apps-section"), list = document.getElementById("apps-list"), status = document.getElementById("apps-order-status");
    let plugins = [], active = null, drag = null;
    const nodes = new Map();
    const announce = value => { status.textContent = value; };
    const order = createOrder({
      save: ids => bridge.call("plugins.order", { ids }), changed: render,
      failed: error => { announce("Could not save the app order. Your previous order has been restored."); notify(error.message || "Could not save the app order.", true); },
    });
    function render() {
      section.hidden = plugins.length === 0;
      const ids = drag?.preview || order.get(), available = new Map(plugins.map(plugin => [plugin.id, plugin]));
      const focused = document.activeElement;
      for (const [id, node] of nodes) if (!available.has(id)) { node.row.remove(); nodes.delete(id); }
      ids.forEach((id, index) => {
        const plugin = available.get(id); if (!plugin) return;
        let node = nodes.get(id);
        if (!node) {
          const row = document.createElement("div"), handle = document.createElement("button"), button = document.createElement("button"), label = document.createElement("span"), disabled = document.createElement("small");
          row.className = "app-nav-row"; row.dataset.appId = id;
          handle.className = "app-reorder-handle"; handle.type = "button"; handle.draggable = true; handle.dataset.reorderApp = id;
          handle.setAttribute("aria-describedby", "apps-reorder-help");
          handle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10"/></svg>';
          button.className = "nav-item app-nav-item"; button.type = "button"; button.dataset.app = id;
          // Presentation icons are static SVG from Core, never plugin markup.
          button.innerHTML = root.KaiPluginPresentation.get(id, plugin).icon;
          button.append(label); row.append(handle, button); node = { row, handle, button, label, disabled }; nodes.set(id, node);
          button.onclick = () => {
            const current = plugins.find(item => item.id === id); if (!current) return;
            if (current.enabled) open(current); else manage(current);
          };
          handle.onkeydown = event => {
            const current = order.get(), from = current.indexOf(id);
            const to = { ArrowUp: from - 1, ArrowDown: from + 1, Home: 0, End: current.length - 1 }[event.key];
            if (to === undefined) return;
            event.preventDefault(); cancelDrag();
            const next = moveId(current, id, to);
            void order.set(next); handle.focus();
            announce(`${root.KaiPluginPresentation.get(id, plugin).name} moved to position ${next.indexOf(id) + 1} of ${next.length}.`);
          };
          handle.ondragstart = event => {
            drag = { id, preview: order.get() };
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", id);
            event.dataTransfer.setDragImage(row, Math.min(40, row.offsetWidth / 2), row.offsetHeight / 2);
            render();
          };
          handle.ondragend = cancelDrag;
          handle.onclick = event => event.preventDefault();
          row.ondragover = event => {
            if (!drag) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "move";
            if (drag.id === id) return;
            const bounds = row.getBoundingClientRect(), next = drag.preview.filter(value => value !== drag.id);
            const target = next.indexOf(id) + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0);
            next.splice(target, 0, drag.id);
            if (next.join("\n") !== drag.preview.join("\n")) { drag.preview = next; render(); }
          };
        }
        const display = root.KaiPluginPresentation.get(id, plugin), selected = active === id;
        if (node.label.firstChild?.nodeType !== 3 || node.label.firstChild.textContent !== display.name) node.label.textContent = display.name;
        node.disabled.textContent = "Disabled";
        if (!plugin.enabled && !node.disabled.parentNode) node.label.append(node.disabled);
        if (plugin.enabled) node.disabled.remove();
        node.button.dataset.disabled = String(!plugin.enabled);
        node.button.setAttribute("aria-label", plugin.enabled ? display.name : `${display.name}, disabled. Open plugin settings to enable.`);
        node.button.setAttribute("aria-current", selected ? "page" : "false");
        node.button.title = plugin.enabled ? display.name : `${display.name} — disabled`;
        node.handle.setAttribute("aria-label", `Reorder ${display.name}`);
        node.handle.title = `Drag to reorder ${display.name}`;
        node.row.classList.toggle("selected", selected); node.button.classList.toggle("selected", selected);
        node.row.classList.toggle("dragging", drag?.id === id);
        if (list.children[index] !== node.row) list.insertBefore(node.row, list.children[index] || null);
      });
      if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }
    function cancelDrag() { if (!drag) return; drag = null; render(); }
    list.ondragover = event => { if (drag) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } };
    list.ondrop = event => {
      if (!drag) return; event.preventDefault();
      const { id, preview } = drag; drag = null;
      void order.set(preview); render(); nodes.get(id)?.handle.focus();
      const name = root.KaiPluginPresentation.get(id, plugins.find(plugin => plugin.id === id)).name;
      announce(`${name} moved to position ${preview.indexOf(id) + 1} of ${preview.length}.`);
    };
    document.addEventListener("keydown", event => { if (event.key === "Escape") cancelDrag(); });
    return {
      update(snapshot) {
        plugins = snapshot.plugins || []; order.sync(plugins, snapshot.pluginsOrder);
        if (drag && !plugins.some(plugin => plugin.id === drag.id)) drag = null;
        if (drag) drag.preview = orderedIds(plugins, drag.preview);
        render();
      },
      select(id) { active = id; render(); },
    };
  }
  const api = Object.freeze({ orderedIds, moveId, createOrder, create });
  if (typeof module === "object") module.exports = api;
  if (root) root.KaiCoreApps = api;
})(typeof window === "object" ? window : null);
