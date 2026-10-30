"use strict";
// Public native-plugin SDK v1. Native execution is fully trusted; this broker
// still keeps credentials out of normal API results and makes user reviews
// consistent. It is not an OS sandbox for native code.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { assertPublicTarget } = require("../core/lib/public-http");
const { pinnedRequest, boundedResponse } = require("./foundation-network");
const CORE_VIEWS = new Set(["chat", "models", "plugins", "wallet", "credits", "buy-credits", "earning", "network", "settings"]);
function createFoundationApi(ctx, record) {
  const { core, electron } = ctx, id = record.manifest.id;
  const signal = record.controller.signal, grants = new Set(record.manifest.permissions);
  const active = () => { signal.throwIfAborted(); if (ctx.isClosing?.()) throw Error("KAI is closing"); };
  const requireGrant = permission => { active(); if (!grants.has(permission)) throw Error(`Plugin requires ${permission}`); };
  const combined = extra => AbortSignal.any([signal, ...(extra ? [extra] : []), AbortSignal.timeout(180000)]);
  const window = () => ctx.getWindow();
  const contents = () => ctx.getWebContents(id);
  const settingsFile = path.join(record.dataDir, "preferences.json");
  let preferences = {};
  if (fs.existsSync(settingsFile)) {
    const st = fs.lstatSync(settingsFile);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4 * 1024 * 1024) throw Error("Invalid plugin preferences; file preserved");
    preferences = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw Error("Unreadable plugin preferences; file preserved");
  }
  const settingKey = key => { if (typeof key !== "string" || !key || key.length > 180 || key.split(".").some(p => ["__proto__", "constructor", "prototype", ""].includes(p))) throw Error("Invalid preference key"); return key.split("."); };
  async function confirm(title, detail) {
    active(); const initiator = record.invocation?.();
    const requester = initiator || null;
    const ownerId = requester?.id || id, w = window(), wc = requester?.webContents || contents(), frame = requester?.frame || wc?.mainFrame;
    const entry = requester?.entry || `kai-plugin://${id}/${record.manifest.entry}`;
    const reviewable = () => (!requester || !requester.signal.aborted) && w && w === window() && !w.isDestroyed() && w.isVisible() && !w.isMinimized() && ctx.isVisible(ownerId) &&
      wc && wc === ctx.getWebContents(ownerId) && !wc.isDestroyed() && wc.mainFrame === frame && frame.url === entry;
    if (!reviewable()) return false;
    const message = String(title), text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    if (!message || message.length > 180 || typeof text !== "string" || text.length > 16000) throw Error("Action details are too long to review");
    const result = await electron.dialog.showMessageBox(w, { type: "question", title: "KAI · Review action", message,
      detail: `${record.manifest.name}${requester && requester.id !== id ? ` · Requested by ${requester.name}` : ""}\n\n${text}`, buttons: ["Cancel", "Allow once"], defaultId: 0, cancelId: 0, noLink: true });
    active(); return result.response === 1 && reviewable();
  }

  const settings = Object.freeze({
    get(key, fallback) { requireGrant("storage.read"); let value = preferences; for (const p of settingKey(key)) value = value && Object.hasOwn(value,p) ? value[p] : undefined; return structuredClone(value === undefined ? fallback : value); },
    set(key, value) {
      requireGrant("storage.write"); const parts = settingKey(key), next = structuredClone(preferences); let at = next;
      for (const p of parts.slice(0,-1)) { if (!at[p] || typeof at[p] !== "object" || Array.isArray(at[p])) at[p] = {}; at = at[p]; }
      at[parts.at(-1)] = structuredClone(value); const json = JSON.stringify(next);
      if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw Error("Plugin preferences exceed 4 MB");
      const temp = settingsFile + "." + crypto.randomUUID() + ".tmp";
      try { fs.writeFileSync(temp,json,{flag:"wx",mode:0o600}); active(); fs.renameSync(temp,settingsFile); preferences=next; }
      finally { fs.rmSync(temp,{force:true}); }
      return structuredClone(value);
    },
  });
  async function modelRequest(input, extraSignal) {
    if (!input || typeof input !== "object" || typeof input.model !== "string" || !Array.isArray(input.messages)) throw Error("Supply a model and messages");
    const network = /^koinos-network(?::|$)/.test(input.model);
    requireGrant(network ? "inference.network" : "inference.local");
    if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024) throw Error("Model input exceeds 16 MB");
    // Network spending always goes through the reviewed shared credit service.
    if (network) {
      const result = await authorize("chat-completion", {...input,stream:false}, extraSignal);
      if (!result?.completion) throw Error(result?.message || "Network completion is unavailable");
      return new Response(JSON.stringify(result.completion),{status:200,headers:{"content-type":"application/json"}});
    }
    if (!core.models.aliases().some(model => model.alias === input.model && model.status === "ready")) throw Error("Choose an installed local model");
    const response = await fetch(`http://127.0.0.1:${core.gateway.port}/core/chat/completions`, { method:"POST", signal:combined(extraSignal), redirect:"error",
      headers:{"content-type":"application/json",...(core.gateway.coreToken ? {authorization:`Bearer ${core.gateway.coreToken}`}:{})},
      body:JSON.stringify({...input,kai_private_desktop:true}) });
    active(); return response;
  }
  function paymentCaller(permission, extraSignal) {
    const origin = record.invocation?.();
    const owner = origin || { id, fingerprint: record.fingerprint, permissions: record.manifest.permissions, webContents: contents(), frame: contents()?.mainFrame, entry: `kai-plugin://${id}/${record.manifest.entry}`, signal };
    if (!owner.permissions.includes(permission)) throw Error(`Initiating plugin requires ${permission}`);
    owner.signal.throwIfAborted();
    const wc = owner.webContents;
    if (!wc || wc.isDestroyed() || wc !== ctx.getWebContents(owner.id) || wc.mainFrame !== owner.frame || wc.mainFrame.url !== owner.entry) throw Error("Open the originating plugin to use network credits");
    return { pluginId: owner.id, fingerprint: owner.fingerprint, entry: owner.entry, window: window(), webContents: wc, isVisible: () => ctx.isVisible(owner.id), signal: AbortSignal.any([combined(extraSignal), owner.signal]) };
  }
  async function authorize(action,input,extraSignal) {
    requireGrant("wallet.authorize");
    return ctx.payments().runForPlugin(action,input,paymentCaller("wallet.authorize",extraSignal));
  }
  async function publicFetch(raw, options={}) {
    requireGrant("network.fetch");
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["method", "headers", "body", "signal"].includes(key))) throw Error("Unsupported network options");
    const permitted = () => { active(); if (core.gateway.network.status().privacyMode === "local-only") throw Error("Local-Only blocks network requests"); };
    permitted(); const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.href.length > 8192) throw Error("Use a public HTTPS URL without credentials");
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(options.method || "GET")) throw Error("Unsupported HTTP method");
    if (["GET", "HEAD"].includes(options.method || "GET") && options.body !== undefined) throw Error("GET and HEAD requests cannot include a body");
    const controller = new AbortController(), release = core.gateway.network.trackShadowRequest(controller);
    const requestSignal = AbortSignal.any([combined(options.signal), controller.signal]);
    try {
      const addresses = await assertPublicTarget(u.href); requestSignal.throwIfAborted(); permitted();
      const response = await pinnedRequest(u, { addresses, signal: requestSignal, method: options.method || "GET", headers: options.headers, body: options.body });
      requestSignal.throwIfAborted(); permitted();
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw Error("Redirects are not allowed; request the destination explicitly"); }
      return boundedResponse(response, { signal: requestSignal, active: permitted, release });
    } catch (error) { release(); throw error; }
  }

  const api = {
    paths:Object.freeze({protected:Object.freeze([path.resolve(record.dataDir,"../../..")])}),
    version:1, plugin:Object.freeze({id,version:record.manifest.version,root:record.root,dataDir:record.dataDir}), signal, settings,
    models:Object.freeze({
      list(){requireGrant("models.read");return structuredClone(core.models.aliases());},
      async ensure({alias}){requireGrant("models.manage");if(!await confirm("Load this model?",String(alias)))throw Error("Model load cancelled");active();return core.runtime.ensure(alias);},
      request:modelRequest,
      async embeddings(input, extraSignal) {
        requireGrant("inference.local");
        if (!input || typeof input !== "object" || typeof input.model !== "string" || !core.models.aliases().some(model => model.alias === input.model && model.status === "ready") || /^(?:desktop:|koinos-network)/.test(input.model)) throw Error("Choose an installed local embedding model");
        if (typeof input.input !== "string" && !Array.isArray(input.input)) throw Error("Supply embedding input text or token arrays");
        const body = JSON.stringify(input); if (Buffer.byteLength(body) > 16*1024*1024) throw Error("Embedding input exceeds 16 MB");
        const response = await fetch(`http://127.0.0.1:${core.gateway.port}/core/embeddings`, { method:"POST", signal:combined(extraSignal),redirect:"error",headers:{"content-type":"application/json",...(core.gateway.coreToken?{authorization:`Bearer ${core.gateway.coreToken}`}:{})},body });
        active(); const result = await response.json(); active(); if (!response.ok) throw Error(result?.error?.message || "Local embeddings failed"); return result;
      },
      async chat(input,s){const r=await modelRequest({...input,stream:false},s),j=await r.json();if(!r.ok)throw Error(j?.error?.message||"Model request failed");return j;},
    }),
    runtime:Object.freeze({status(){requireGrant("models.read");return structuredClone(core.runtime.status());}}),
    network:Object.freeze({
      status(){requireGrant("network.status");return structuredClone(core.gateway.network.status());},
      async configure({privacyMode}){requireGrant("network.configure");if(!["local-only","local-first","network"].includes(privacyMode))throw Error("Invalid privacy mode");if(!await confirm("Change AI privacy?",privacyMode))throw Error("Privacy change cancelled");return ctx.setPrivacyMode(privacyMode);},
      async models(){requireGrant("inference.network");const r=await ctx.payments().runForPlugin("chat-info",undefined,paymentCaller("inference.network"));return r?.models||[];},
      fetch:publicFetch,
    }),
    secrets:Object.freeze({
      isEncryptionAvailable(){requireGrant("secrets.use");return electron.safeStorage.isEncryptionAvailable();},
      getSelectedStorageBackend(){requireGrant("secrets.use");return electron.safeStorage.getSelectedStorageBackend?.()||process.platform;},
      encryptString(text){requireGrant("secrets.use");return electron.safeStorage.encryptString(text);},
      decryptString(value){requireGrant("secrets.use");return electron.safeStorage.decryptString(Buffer.from(value));},
    }),
    desktop:Object.freeze({
      hostWindowId(){requireGrant("desktop.windows");return window()?.id||null;},
      rendererId(){requireGrant("desktop.windows");return contents()?.id||null;},
      isVisible(){active();return ctx.isVisible(id);},
      send(channel,value){requireGrant("desktop.windows");if(typeof channel!=="string"||channel.length>180)throw Error("Invalid event channel");contents()?.send(channel,value);},
      async openPlugin(pluginId,section){requireGrant("desktop.navigate");return ctx.openPlugin(pluginId,section);},
      async openCore(view,section){requireGrant("desktop.navigate");if(!CORE_VIEWS.has(view))throw Error("Unknown Core page");if(section!==undefined&&(view!=="settings"||!["website-account","credit-account"].includes(section)))throw Error("Unknown Core section");return ctx.openCoreView(view,section);},
      async openExternal(raw){requireGrant("desktop.external");const u=new URL(raw);if(u.protocol!=="https:"||u.username||u.password)throw Error("Use HTTPS without credentials");if(!await confirm("Open website?",u.href))return{cancelled:true};await electron.shell.openExternal(u.href);return{opened:true};},
      confirm,
      preferences(){requireGrant("desktop.preferences");return {language:core.settings.get("interface.language","en"),theme:core.settings.get("interface.theme","light")};},
      setPreferences(input){requireGrant("desktop.preferences");if(!input||Object.keys(input).some(k=>!["language","theme"].includes(k)))throw Error("Unsupported preference");if(input.language!==undefined){if(typeof input.language!=="string"||!/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(input.language))throw Error("Invalid language");core.settings.set("interface.language",input.language);}if(input.theme!==undefined){if(!["light","dark","system"].includes(input.theme))throw Error("Invalid theme");core.settings.set("interface.theme",input.theme);}return api.desktop.preferences();},
      on(channel,handler){requireGrant("desktop.windows");if(!["show","hide","closed","focus","blur"].includes(channel)||typeof handler!=="function")throw Error("Invalid desktop event");const w=window();w.on(channel,handler);const remove=()=>w.removeListener(channel,handler);signal.addEventListener("abort",remove,{once:true});return remove;},
    }),
    account:Object.freeze({
      status(){requireGrant("account.request");const account=core.account;return {origin:account.origin(),signedIn:!!account._token(),binding:crypto.createHash("sha256").update(`${account.origin()}|${account._token()||""}`).digest("hex")};},
      async request(relative,{method="GET",body,signal:s}={}){
        requireGrant("account.request");if(core.gateway.network.status().privacyMode==="local-only")throw Error("Local-Only blocks account services");
        if(typeof relative!=="string"||!relative.startsWith("/")||relative.startsWith("//")||relative.includes("\\"))throw Error("Use an account-relative path");
        const account=core.account,origin=account.origin(),u=new URL(relative,origin);if(u.origin!==origin)throw Error("Account origin mismatch");
        const token=account._token();if(!token)throw Error("Sign in to your KAI account first");
        const payload=body===undefined?undefined:JSON.stringify(body);if(payload&&Buffer.byteLength(payload)>4*1024*1024)throw Error("Account request too large");
        if (!u.pathname.startsWith("/") || !["GET","POST","PUT","PATCH","DELETE","HEAD"].includes(method)) throw Error("Invalid account request");
        if (["GET","HEAD"].includes(method) && payload !== undefined) throw Error("GET and HEAD requests cannot include a body");
        const controller = new AbortController(), release = core.gateway.network.trackShadowRequest(controller);
        const requestSignal = AbortSignal.any([combined(s), controller.signal]);
        const unchanged = () => { active(); requestSignal.throwIfAborted(); if (core.gateway.network.status().privacyMode === "local-only") throw Error("Local-Only blocks account services"); if(token!==account._token()||origin!==account.origin())throw Error("Signed-in account changed"); };
        try {
          unchanged();
          const response = await fetch(u.href,{method,body:payload,redirect:"error",signal:requestSignal,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"}});
          unchanged(); return boundedResponse(response, { signal: requestSignal, active: unchanged, release, limit: 4*1024*1024 });
        } catch (error) { release(); throw error; }

      },
    }),
    wallet:Object.freeze({summary(){requireGrant("wallet.read");return ctx.wallet().call("wallet.summary",{});},authorize}),
    log(level,message){active();if(!["info","warn","error"].includes(level))throw Error("Invalid log level");console[level](`[plugin:${id}] ${String(message).slice(0,4000)}`);},
  };
  return api;
}
module.exports={createFoundationApi,CORE_VIEWS};
