"use strict";
const path = require("node:path"), crypto = require("node:crypto");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain" };
Object.assign(MIME, { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".woff": "font/woff", ".woff2": "font/woff2" });
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
class PluginHost {
  constructor({ electron, manager, core, features }) {
    Object.assign(this, { electron, manager, core, features }); this.windows = new Map(); this.active = 0;
    electron.ipcMain.handle("kai-plugin:call", (event, method, input) => this.call(event, method, input));
  }
  async open(id) {
    await this.features?.closeTasks?.get(id);
    const existing = this.windows.get(id); if (existing) { existing.window.show(); existing.window.focus(); return; }
    const { manifest, package: pkg, fingerprint } = this.manager.load(id);
    const official = require("../core/lib/plugins/first-party.json").plugins.some(p => p.id === id && p.fingerprint === fingerprint);
    if (!official && [...this.windows.values()].filter(record => !record.official).length >= 8) throw Error("Close a third-party plugin window before opening another (limit: 8)");
    const assistantMedia = official && id === "kai.assistant" && manifest.permissions.includes("assistant.media");
    const csp = official ? CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") + "; font-src 'self'; media-src 'self' blob:" : CSP;
    const session = this.electron.session.fromPartition(`kai-plugin-${crypto.randomUUID()}`);
    const origin = `kai-plugin://${id}`, entry = `${origin}/${manifest.entry}`;
    session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", event => event.preventDefault());
    session.webRequest.onBeforeRequest((details, cb) => {
      let allowed = false; try { const u = new URL(details.url); allowed = u.protocol === "kai-plugin:" && u.hostname === id && !u.username && !u.password && !u.port || official && u.protocol === "blob:" && u.pathname.startsWith(origin + "/"); } catch {}
      cb({ cancel: !allowed });
    });
    session.protocol.handle("kai-plugin", request => {
      let u, file;
      try { u = new URL(request.url); file = decodeURIComponent(u.pathname.slice(1)); }
      catch { return new Response("Invalid request", { status: 400 }); }
      if (u.hostname !== id || request.method !== "GET" || !Object.hasOwn(pkg.files, file)) return new Response("Not found", { status: 404 });
      const binary = require("../core/lib/plugins/package").BINARY.test(file);
      return new Response(binary ? Buffer.from(pkg.files[file], "base64") : pkg.files[file], { headers: { "content-type": `${MIME[path.extname(file)] || "text/plain"}${binary ? "" : "; charset=utf-8"}`, "content-security-policy": csp, "x-content-type-options": "nosniff" } });
    });
    const window = new this.electron.BrowserWindow({ width: 1000, height: 760, title: manifest.name, backgroundColor: "#f4f7fd", show: false,
      webPreferences: { session, preload: path.join(__dirname, "core-plugin-preload.js"), sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, devTools: false } });
    // WebRTC UDP is not an HTTP request and cannot be filtered by webRequest.
    window.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const record = { window, manifest, entry, fingerprint, official, controller: new AbortController(), busy: false, calls: [] };
    this.windows.set(id, record);
    if (assistantMedia) {
      const granted = new Set();
      session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => permission === "media" && wc === window.webContents && [origin, origin + "/"].includes(requestingOrigin) && details?.isMainFrame === true && details.requestingUrl === entry && window.webContents.mainFrame.url === entry && !record.controller.signal.aborted && !!this.manager.state.installed[id]?.enabled && granted.has(details?.mediaType));
      session.setPermissionRequestHandler(async (wc, permission, callback, details) => {
        const types = details?.mediaTypes || [];
        if (permission !== "media" || wc !== window.webContents || details?.isMainFrame !== true || details.requestingUrl !== entry || wc.mainFrame.url !== entry || !types.length || types.some(type => !["audio", "video"].includes(type)) || record.controller.signal.aborted || !this.manager.state.installed[id]?.enabled) return callback(false);
        try {
          if (!types.every(type => granted.has(type))) {
            const answer = await this.electron.dialog.showMessageBox(window, { type: "question", title: "KAI Assistant media access", message: `Allow KAI Assistant to use your ${types.map(type => type === "audio" ? "microphone" : "camera").join(" and ")}?`, detail: "Access is used for the voice or camera feature you start. This permission lasts until this Assistant window closes.", buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0 });
            if (answer.response !== 1 || record.controller.signal.aborted || wc.mainFrame.url !== entry || !this.manager.state.installed[id]?.enabled) return callback(false);
            types.forEach(type => granted.add(type));
          }
          callback(true);
        } catch { callback(false); }
      });
    }
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const action of ["will-navigate", "will-redirect", "will-attach-webview"]) window.webContents.on(action, event => event.preventDefault());
    window.once("closed", () => { record.controller.abort(); this.windows.delete(id); void (this.features?.detachWindow?.(id) || this.features?.close(id))?.catch(error => console.warn("[plugin]", error.message)); session.protocol.unhandle("kai-plugin"); void session.clearStorageData().catch(() => {}); });
    try { await window.loadURL(entry); window.show(); } catch (error) { window.destroy(); throw error; }
  }
  close(id, reason = "disable") { this.windows.get(id)?.window.destroy(); return this.features?.close(id, { reason }) || Promise.resolve(); }
  closeAll() { return Promise.allSettled([...this.windows.keys()].map(id => this.close(id, "quit"))); }
  async call(event, method, input) {
    const record = [...this.windows.values()].find(r => r.window.webContents === event.sender);
    if (!record || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== record.entry) throw Error("Plugin caller denied");
    const now = Date.now(); record.calls = record.calls.filter(time => now - time < 1000);
    if (record.calls.length >= 30) throw Error("Plugin request rate exceeded; wait a moment before retrying");
    record.calls.push(now);
    const { manifest: m } = record;
    if (!this.manager.state.installed[m.id]?.enabled) throw Error("Plugin is disabled");
    const permissions = { "models.list": "models.read", "inference.local": "inference.local", "storage.get": "storage.read", "storage.set": "storage.write" };
    const permission = typeof method === "string" ? (Object.hasOwn(permissions, method) ? permissions[method] : this.features?.permission(method)) : null;
    if (!permission || !m.permissions.includes(permission)) throw Error("Plugin permission denied");
    const inputLimit = record.official && record.manifest.id === "kai.assistant" && record.manifest.permissions.includes("assistant.media") ? 24 * 1024 * 1024
      : record.official && record.manifest.id === "kai.documents" && record.manifest.permissions.includes("documents.write") ? 12 * 1024 * 1024 : 1024 * 1024;
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > inputLimit) throw Error("Plugin input too large");
    if (method === "models.list") return this.core.models.aliases().map(({ alias, label, status }) => ({ alias, label, status }));
    if (method.startsWith("storage.")) return this.manager.storage(m.id, method.slice(8), input?.key, input?.value);
    if (!Object.hasOwn(permissions, method)) return this.features.call(record, method, input);
    if (record.busy) throw Error("Inference is busy; retry after the current request");
    record.busy = true;
    try { return await this.runLocal(input, record.controller.signal); } finally { record.busy = false; }
  }
  async runLocal(input, signal) {
    if (signal?.aborted) throw Error("Plugin is closing");
    if (this.active >= 2) throw Error("Inference is busy; retry after the current request");
    if (!input || typeof input.prompt !== "string" || input.prompt.length > 16000 || typeof input.model !== "string" || !this.core.models.aliases().some(a => a.alias === input.model && a.status === "ready")) throw Error("Choose an installed local model and a prompt under 16,000 characters");
    if (!Number.isInteger(input.maxTokens ?? 1024) || (input.maxTokens ?? 1024) < 1 || (input.maxTokens ?? 1024) > 4096) throw Error("Invalid output limit");
    this.active++;
    try {
      const response = await fetch(`http://127.0.0.1:${this.core.gateway.port}/core/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", ...(process.env.KAI_CORE_TOKEN ? { authorization: `Bearer ${process.env.KAI_CORE_TOKEN}` } : {}) },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]),
        body: JSON.stringify({ model: input.model, stream: false, kai_private_desktop: true, max_tokens: input.maxTokens ?? 1024, messages: [{ role: "user", content: input.prompt }] }) });
      const result = await response.json(); if (!response.ok) throw Error(result?.error?.message || "Local inference failed");
      const output = result?.choices?.[0]?.message?.content; if (typeof output !== "string" || output.length > 1000000) throw Error("Invalid inference result");
      return { text: output };
    } finally { this.active--; }
  }
}
module.exports = { PluginHost, CSP };
