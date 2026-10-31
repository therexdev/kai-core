"use strict";
(() => {
  // These labels describe declared capabilities, not a sandbox for native code.
  // Manifest text is never markup.
  const permissionLabels = Object.freeze({
    "native.execute":"Run native code with KAI’s operating-system permissions",
    "models.read":"View installed models", "models.manage":"Set up and load models", "inference.local":"Run local AI models", "inference.network":"Request network AI",
    "storage.read":"Read plugin settings", "storage.write":"Save plugin settings", "secrets.use":"Use secure credential storage",
    "network.status":"Read network policy", "network.configure":"Request privacy changes", "network.fetch":"Make network requests",
    "desktop.navigate":"Open KAI pages and installed apps", "desktop.external":"Request browser links", "desktop.preferences":"Read and change interface preferences",
    "desktop.media":"Request microphone and camera access", "desktop.windows":"Create native windows and desktop controls",
    "account.request":"Use your signed-in KAI account for service requests", "wallet.read":"Read wallet summaries", "wallet.authorize":"Request reviewed credit and payment actions",
    "services.call":"Use declared services from installed plugins", "services.provide":"Provide declared services to other plugins"
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
      byId("permissions-heading").textContent = data.runtime === "native" ? "Declared capabilities" : "Requested access";
      byId("access-note").textContent = data.runtime === "native"
        ? "Native code: this plugin runs with the same operating-system permissions as KAI. It can access files and app data available to KAI, including credentials, make network connections, and run programs. The listed capabilities control KAI API calls; they do not restrict native code. This does not automatically grant administrator access. Install only if you trust the publisher."
        : "This plugin runs in a sandboxed view. Core provides only its granted APIs.";
      byId("access-note").classList.toggle("native-trust", data.runtime === "native");

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
