"use strict";
(() => {
  // These labels describe native capabilities. Manifest text is never markup.
  const permissionLabels = Object.freeze({
    "models.read": "View your installed models",
    "inference.local": "Run local AI models",
    "storage.read": "Read this plugin’s saved data",
    "storage.write": "Save this plugin’s data",
    "assistant.chat": "Use Assistant chat and AI features",
    "assistant.native": "Manage model providers and companion features",
    "assistant.network": "Use network chat and manage AI privacy settings",
    "assistant.read": "Read saved chats and open related views or links",
    "assistant.media": "Use Assistant audio and image features",
    "assistant.write": "Save, edit and delete Assistant chats",
    "desktop.navigate": "Open other KAI pages and apps",
    "desktop.external": "Request to open websites in your browser",
    "desktop.preferences": "Read language and interface preferences",
    "brain.read": "Read Brain memories, notes, sources and goals",
    "brain.write": "Manage Brain data and awareness tasks",
    "brain.import": "Import and sync Brain sources",
    "brain.export": "Export Brain data",
    "brain.workflow": "Run workflows from Brain",
    "documents.draft": "Draft and edit documents with AI",
    "documents.read": "Read your saved documents",
    "documents.write": "Save, edit and delete documents",
    "documents.import": "Import documents you choose",
    "documents.export": "Export documents to files",
    "workflows.read": "Read and export workflows, agents and run history",
    "workflows.write": "Create, import, edit and delete workflows and agents",
    "workflows.run": "Run, schedule and manage workflow jobs",
    "agent-network.read": "Read agent services and their activity",
    "agent-network.write": "Create and edit agent services",
    "agent-network.network": "Discover, publish and use network agent services",
    "agent-network.manage": "Manage agent service settings and jobs",
    "connections.read": "View connected apps and available tools",
    "connections.manage": "Manage connected accounts and their permissions",
    "connections.execute": "Request actions through connected apps",
    "connections.brain": "Import and sync connected sources into Brain",
    "tools.read": "View tool servers and available tools",
    "tools.manage": "Manage tool servers and developer workspaces",
    "tools.execute": "Run tools and request network AI",
    "code.execute": "Run coding tasks and request project actions",
    "code.read": "Read selected projects and coding sessions",
    "code.assist": "Generate AI suggestions for selected projects",
    "code.write": "Propose and apply approved project file changes",
    "koinos-node.read": "View node status, logs and history",
    "koinos-node.manage": "Set up, configure, start and stop your node",
    "koinos-node.wallet": "Use node wallet features through KAI",
    "koinos-node.fund": "Request node funding and wallet transactions",
    "remote-access.keys": "Create and manage remote API keys",
    "remote-access.read": "View remote access settings, keys and activity",
    "remote-access.control": "Start, stop and configure remote access",
    "compare.run": "Run local and network model comparisons",
    "remote-access.features": "Legacy optional-workspace access (no longer available)",
  });
  const byId = id => document.getElementById(id);
  const cancel = byId("cancel-install"), approve = byId("approve-install"), close = byId("close-install");
  let ready = false, pending = false;

  function error(message) {
    ready = false; approve.disabled = true;
    byId("review-loading").hidden = true;
    byId("review-content").setAttribute("aria-busy", "false");
    byId("review-error").textContent = message;
    byId("review-error").hidden = false;
  }
  async function decide(choice) {
    if (pending || (choice === "approve" && !ready)) return;
    pending = true; approve.disabled = true;
    try {
      await window.kaiPluginInstall.decide(choice);
    } catch {
      pending = false;
      error("This review could not be completed. Close this window and try installing the plugin again.");
      cancel.focus();
    }
  }
  cancel.addEventListener("click", () => void decide("cancel"));
  close.addEventListener("click", () => void decide("cancel"));
  approve.addEventListener("click", () => void decide("approve"));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); void decide("cancel"); return; }
    if (event.key !== "Tab") return;
    const focusable = [...document.querySelectorAll("button:not(:disabled), summary")].filter(el => el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  cancel.focus();
  async function load() {
    try {
      const data = await window.kaiPluginInstall.read();
      if (!data || typeof data.name !== "string" || typeof data.version !== "string" || typeof data.id !== "string" || typeof data.fingerprint !== "string" || !Array.isArray(data.permissions) || data.permissions.some(p => typeof p !== "string")) throw Error("Invalid review");
      const updating = !!data.installedVersion;
      byId("review-heading").textContent = updating ? "Update plugin" : "Install plugin";
      document.title = `${updating ? "Update" : "Install"} plugin · KAI`;
      approve.textContent = updating ? "Update plugin" : "Install plugin";
      close.setAttribute("aria-label", updating ? "Cancel plugin update" : "Cancel plugin installation");
      byId("plugin-name").textContent = data.name;
      byId("plugin-version").textContent = updating ? `Version ${data.installedVersion} → ${data.version}` : `Version ${data.version}`;
      byId("plugin-description").textContent = data.description || "";
      byId("plugin-description").hidden = !data.description;
      // Only bundled SVG paths enter this element. Names/descriptions remain text.
      byId("plugin-icon").innerHTML = window.KaiPluginPresentation.get(data.official ? data.id : "").icon;
      byId("publisher-label").textContent = data.official ? "KAI publisher · signed package" : "Signed package";
      byId("plugin-id").textContent = data.id;
      byId("publisher-fingerprint").textContent = data.fingerprint;
      byId("permission-count").textContent = `${data.permissions.length} ${data.permissions.length === 1 ? "permission" : "permissions"}`;
      for (const permission of data.permissions) {
        const row = document.createElement("li");
        row.dataset.permission = permission;
        row.textContent = Object.hasOwn(permissionLabels, permission) ? permissionLabels[permission] : permission;
        byId("permission-list").append(row);
        const raw = document.createElement("li"); raw.textContent = permission;
        byId("permission-ids").append(raw);
      }
      if (!data.permissions.length) byId("permission-ids").textContent = "None";
      byId("permission-list").hidden = !data.permissions.length;
      byId("no-permissions").hidden = !!data.permissions.length;
      byId("review-loading").hidden = true;
      byId("review-ready").hidden = false;
      byId("review-content").setAttribute("aria-busy", "false");
      ready = true; approve.disabled = pending;
    } catch { error("Plugin details could not be loaded. Close this window and try again."); }
  }
  void load();
})();
