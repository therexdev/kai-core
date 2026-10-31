"use strict";
const path = require("node:path"), crypto = require("node:crypto"), fs = require("node:fs");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".txt": "text/plain" };
Object.assign(MIME, { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".woff": "font/woff", ".woff2": "font/woff2" });
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
class PluginHost {
  constructor({ electron, manager, core, features, getContainerWindow, onActivate }) {
    Object.assign(this, { electron, manager, core, features, getContainerWindow, onActivate });
    this.windows = new Map(); this.openings = new Map(); this.active = 0; this.selected = null; this.activation = 0; this.bounds = null;
    electron.ipcMain.handle("kai-plugin:call", (event, method, input) => this.call(event, method, input));
    electron.ipcMain.handle("kai-plugin:dialog", (event, kind, input) => this.rendererDialog(event, kind, input));
    const container = getContainerWindow?.();
    if (container) {
      this.resize = () => this.applyBounds();
      container.on("resize", this.resize);
      container.webContents.on("zoom-changed", this.resize);
      // A Core reload must never leave an app covering a newly loaded Core page.
      container.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.hide(); });
    }
  }
  renderer(id) { return this.windows.get(id)?.webContents; }
  isVisible(id) { const record = this.windows.get(id); return !!record && !record.window.isDestroyed() && record.window.isVisible() && !record.window.isMinimized() && (!record.view || this.selected === id && record.view.getVisible()); }
  async open(id, bounds) {
    if (typeof id !== "string") throw Error("Choose an installed app");
    const activation = ++this.activation;
    if (this.getContainerWindow) { this.selected = null; this.hideViews(); }
    await this.features?.closeTasks?.get(id);
    // A running view uses the exact signed bytes already verified at launch.
    // Recheck installed identity/grants; avoid rehashing large voice payloads on
    // every navigation. New views always verify the signed package again.
    const current = this.windows.get(id);
    if (current) this.manager.assertActive(id, current.digest, current.fingerprint);
    const verified = current || (this.features?.verifiedForUI ? await this.features.verifiedForUI(id) : this.manager.load(id));
    if (activation !== this.activation) { if (!current && verified.manifest.runtime === "sandboxed") verified.dispose?.(); return { opened: false }; }
    if (this.getContainerWindow) {
      this.hideViews(); this.selected = id;
      if (bounds) this.setBounds(bounds, id);
      this.onActivate?.({ page: "app", id, name: verified.manifest.name });
    }
    let pending = this.openings.get(id);
    if (!this.windows.has(id) && !pending) {
      pending = this.create(id, verified); this.openings.set(id, pending);
      void pending.finally(() => { if (this.openings.get(id) === pending) this.openings.delete(id); }).catch(() => {});
    }
    try { if (pending) await pending; }
    catch (error) {
      if (!current && verified.manifest.runtime === "sandboxed") verified.dispose?.();
      if (activation === this.activation && this.getContainerWindow) { this.hide(); this.onActivate?.({ page: "plugins", error: error.message }); }
      throw error;
    }
    const record = this.windows.get(id);
    if (!record || activation !== this.activation) return { opened: false };
    if (record.view) {
      this.applyBounds();
      if (record.window.isMinimized()) record.window.restore();
      record.window.show(); record.window.focus(); record.webContents.focus();
    } else { record.window.show(); record.window.focus(); }
    return { opened: true, id };
  }
  setBounds(bounds, id) {
    if (id && id !== this.selected) return { updated: false };
    if (!bounds || typeof bounds !== "object" || Array.isArray(bounds) || Object.keys(bounds).some(key => !["x", "y", "width", "height"].includes(key)) ||
        ["x", "y", "width", "height"].some(key => !Number.isFinite(bounds[key]) || bounds[key] < 0 || bounds[key] > 32768)) throw Error("Invalid app bounds");
    this.bounds = Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.round(value)]));
    this.applyBounds(); return { updated: true };
  }
  applyBounds() {
    const record = this.windows.get(this.selected), window = this.getContainerWindow?.();
    if (!record?.view || !this.bounds || !window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize(), scale = window.webContents.getZoomFactor();
    const x = Math.min(width, Math.round(this.bounds.x * scale)), y = Math.min(height, Math.round(this.bounds.y * scale));
    const bounds = { x, y, width: Math.max(0, Math.min(width - x, Math.round(this.bounds.width * scale))), height: Math.max(0, Math.min(height - y, Math.round(this.bounds.height * scale))) };
    record.view.setBounds(bounds); record.view.setVisible(record.ready && bounds.width > 0 && bounds.height > 0);
  }
  cancelDialogs(record) { record.dialogController?.abort(); record.dialogController = new AbortController(); }
  dialogSignal(id) { const record = this.windows.get(id); return record?.dialogController?.signal; }
  hideViews() { for (const record of this.windows.values()) if (record.view) { this.cancelDialogs(record); record.view.setVisible(false); } }
  hide() { ++this.activation; this.selected = null; this.hideViews(); return { hidden: true }; }
  async create(id, { manifest, package: pkg, fingerprint, digest, root, dispose: releasePackage }) {
    if (this.windows.size >= 24) throw Error("Close an unused app before opening another (limit: 24)");
    const mediaAccess = manifest.permissions.includes("desktop.media");
    const csp = CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") + "; font-src 'self'; media-src 'self' blob:";
    const session = this.electron.session.fromPartition(`kai-plugin-${crypto.randomUUID()}`);
    const origin = `kai-plugin://${id}`, entry = `${origin}/${manifest.entry}`;
    session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", event => event.preventDefault());
    session.webRequest.onBeforeRequest((details, cb) => {
      let allowed = false; try { const u = new URL(details.url); allowed = u.protocol === "kai-plugin:" && u.hostname === id && !u.username && !u.password && !u.port || mediaAccess && u.protocol === "blob:" && u.pathname.startsWith(origin + "/"); } catch {}
      cb({ cancel: !allowed });
    });
    session.protocol.handle("kai-plugin", request => {
      let u, file;
      try { u = new URL(request.url); file = decodeURIComponent(u.pathname.slice(1)); }
      catch { return new Response("Invalid request", { status: 400 }); }
      if (u.hostname !== id || request.method !== "GET" || !Object.hasOwn(pkg.files, file)) return new Response("Not found", { status: 404 });
      const binary = require("../core/lib/plugins/package").BINARY.test(file);
      return new Response(root ? fs.readFileSync(path.join(root, ...file.split("/"))) : binary ? Buffer.from(pkg.files[file], "base64") : pkg.files[file], { headers: { "content-type": `${MIME[path.extname(file)] || "text/plain"}${binary ? "" : "; charset=utf-8"}`, "content-security-policy": csp, "x-content-type-options": "nosniff" } });
    });
    const preferences = { session, preload: path.join(__dirname, "core-plugin-preload.js"), sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, webviewTag: false, devTools: false, backgroundThrottling: false };
    const container = this.getContainerWindow?.();
    if (this.getContainerWindow && (!container || container.isDestroyed())) throw Error("Core window is unavailable");
    const view = container ? new this.electron.WebContentsView({ webPreferences: preferences }) : null;
    const window = container || new this.electron.BrowserWindow({ width: 1000, height: 760, title: manifest.name, backgroundColor: "#f4f7fd", show: false, webPreferences: preferences });
    const webContents = view?.webContents || window.webContents;
    if (view) { view.setBackgroundColor("#f4f7fd"); view.setVisible(false); container.contentView.addChildView(view); }
    // WebRTC UDP is not an HTTP request and cannot be filtered by webRequest.
    webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const record = { window, view, webContents, manifest, entry, fingerprint, digest, root, controller: new AbortController(), dialogController: new AbortController(), busy: false, calls: [], ready: false };
    this.windows.set(id, record);
    webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.cancelDialogs(record); });
    if (mediaAccess) {
      const granted = new Set();
      session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => permission === "media" && wc === webContents && [origin, origin + "/"].includes(requestingOrigin) && details?.isMainFrame === true && details.requestingUrl === entry && webContents.mainFrame.url === entry && !record.controller.signal.aborted && !!this.manager.state.installed[id]?.enabled && granted.has(details?.mediaType));
      session.setPermissionRequestHandler(async (wc, permission, callback, details) => {
        callback(await this.reviewMedia(record, granted, wc, permission, details));
      });
    }
    webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const action of ["will-navigate", "will-redirect", "will-attach-webview"]) webContents.on(action, event => event.preventDefault());
    const cleanup = () => {
      if (record.cleaned) return; record.cleaned = true; record.controller.abort(); this.cancelDialogs(record);
      if (this.windows.get(id) === record) this.windows.delete(id);
      if (view && !window.isDestroyed()) window.contentView.removeChildView(view);
      if (!record.closingReason) void (this.features?.detachWindow?.(id) || this.features?.close(id))?.catch(error => console.warn("[plugin]", error.message));
      session.protocol.unhandle("kai-plugin"); if (manifest.runtime === "sandboxed") releasePackage?.(); void session.clearStorageData().catch(() => {});
    };
    record.cleanup = cleanup;
    if (view) webContents.once("destroyed", cleanup); else window.once("closed", cleanup);
    webContents.once("render-process-gone", () => {
      if (record.view) record.view.setVisible(false);
      if (this.selected === id) { this.hide(); this.onActivate?.({ page: "plugins" }); }
      this.destroyRecord(record);
    });
    try { if (view) await webContents.loadURL(entry); else await window.loadURL(entry); record.ready = true; }
    catch (error) { this.destroyRecord(record); throw error; }
  }
  destroyRecord(record) {
    if (!record || record.cleaned) return;
    if (record.view) { record.cleanup(); if (!record.webContents.isDestroyed()) record.webContents.close({ waitForBeforeUnload: false }); }
    else record.window.destroy();
  }
  close(id, reason = "disable") {
    if (this.selected === id) { this.hide(); this.onActivate?.({ page: "plugins" }); }
    const record = this.windows.get(id); if (record) record.closingReason = reason;
    this.destroyRecord(record); return this.features?.close(id, { reason }) || Promise.resolve();
  }
  closeAll() { this.hide(); return Promise.allSettled([...this.windows.keys()].map(id => this.close(id, "quit"))); }
  async reviewMedia(record, granted, wc, permission, details) {
    const types = details?.mediaTypes;
    if (permission !== "media" || wc !== record.webContents || details?.isMainFrame !== true || details.requestingUrl !== record.entry || !Array.isArray(types) || !types.length || types.some(type => !["audio", "video"].includes(type))) return false;
    const id = record.manifest.id, frame = wc.mainFrame;
    const signal = AbortSignal.any([record.controller.signal, record.dialogController.signal]);
    const reviewable = () => !signal.aborted && this.windows.get(id) === record && this.isVisible(id) && !wc.isDestroyed() && wc.mainFrame === frame && frame.url === record.entry && !!this.manager.state.installed[id]?.enabled;
    if (!reviewable()) return false;
    try {
      this.manager.assertActive(id, record.digest, record.fingerprint);
      if (!types.every(type => granted.has(type))) {
        const answer = await this.electron.dialog.showMessageBox(record.window, { type: "question", title: `${record.manifest.name} media access`, message: `Allow ${record.manifest.name} to use your ${types.map(type => type === "audio" ? "microphone" : "camera").join(" and ")}?`, detail: "Access is used for the voice or camera feature you start. This permission lasts until KAI quits or Assistant is disabled or updated.", buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0, signal });
        if (answer.response !== 1 || !reviewable()) return false;
        this.manager.assertActive(id, record.digest, record.fingerprint);
        types.forEach(type => granted.add(type));
      }
      return reviewable();
    } catch { return false; }
  }
  async rendererDialog(event, kind, input) {
    const record = [...this.windows.values()].find(r => r.webContents === event.sender);
    if (!record || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== record.entry) throw Error("Plugin caller denied");
    this.manager.assertActive(record.manifest.id, record.digest, record.fingerprint);
    if (record.dialogPending) throw Error("Finish the current app dialog first");
    const frame = event.senderFrame, signal = AbortSignal.any([record.controller.signal, record.dialogController.signal]);
    const reviewable = () => !signal.aborted && this.windows.get(record.manifest.id) === record && this.isVisible(record.manifest.id) && !record.webContents.isDestroyed() && record.webContents.mainFrame === frame && frame.url === record.entry;
    record.dialogPending = true;
    try {
      const result = await require("./core-renderer-dialogs").showRendererDialog({ dialog: this.electron.dialog, parent: record.window, name: record.manifest.name, kind, input, signal, reviewable });
      if (signal.aborted) return kind === "confirm" ? false : undefined;
      this.manager.assertActive(record.manifest.id, record.digest, record.fingerprint); return result;
    } finally { record.dialogPending = false; }
  }
  async call(event, method, input) {
    const record = [...this.windows.values()].find(r => r.webContents === event.sender);
    if (!record || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== record.entry) throw Error("Plugin caller denied");
    const now = Date.now(); record.calls = record.calls.filter(time => now - time < 1000);
    if (record.calls.length >= 30) throw Error("Plugin request rate exceeded; wait a moment before retrying");
    record.calls.push(now);
    const { manifest: m } = record;
    this.manager.assertActive(m.id, record.digest, record.fingerprint);
    const permissions = { "models.list": "models.read", "inference.local": "inference.local", "storage.get": "storage.read", "storage.set": "storage.write" };
    const permission = typeof method === "string" && Object.hasOwn(permissions, method) ? permissions[method] : null;
    if (permission ? !m.permissions.includes(permission) : m.runtime !== "native" || !m.permissions.includes("native.execute")) throw Error("Plugin permission denied");
    const inputLimit = m.runtime === "native" ? 24 * 1024 * 1024 : 1024 * 1024;
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > inputLimit) throw Error("Plugin input too large");
    if (method === "models.list") return this.core.models.aliases().map(({ alias, label, status }) => ({ alias, label, status }));
    if (method.startsWith("storage.")) return this.manager.storage(m.id, method.slice(8), input?.key, input?.value);
    if (!permission) return this.features.call(record, method, input);
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
