"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { RemoteTunnel, RELAY } = require("./remote-tunnel");
const pluginId = "kai.remote-access";
const permissions = Object.freeze({
  "remote.status": "remote-access.read", "remote.keys": "remote-access.read", "remote.copyEndpoint": "remote-access.read",
  "remote.start": "remote-access.control", "remote.stop": "remote-access.control", "remote.rotate": "remote-access.control",
  "remote.keyCreate": "remote-access.keys", "remote.keyRevoke": "remote-access.keys", "remote.keyAdopt": "remote-access.keys",
});
function object(value, fields = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 4096 || Object.keys(value).some(k => !fields.includes(k))) throw Error("Invalid Remote Access request");
  return structuredClone(value);
}
function create(ctx) {
  let closed = false, busy = false, tunnel = null, stopping = null, privacyTimer = null, clipboardTimer = null, copiedKey = null, sessionRevision = 0;
  let settingsExisted = fs.existsSync(path.join(ctx.dataDir, "settings.json"));
  const mode = () => ctx.core.gateway.network.status().privacyMode;
  function active(signal) { signal?.throwIfAborted(); if (closed) throw Error("Remote Access is closed"); }
  function checkSettings() {
    const file = path.join(ctx.dataDir, "settings.json");
    const ancestors = []; for (let candidate = path.resolve(ctx.dataDir); ; candidate = path.dirname(candidate)) { ancestors.push(candidate); if (path.dirname(candidate) === candidate) break; }
    for (const candidate of [...ancestors, file]) {
      let st; try { st = fs.lstatSync(candidate); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (st.isSymbolicLink() || (candidate === file && (!st.isFile() || st.nlink !== 1 || st.size > 8 * 1024 * 1024))) throw Error("Settings need recovery; existing Remote Access data was preserved");
    }
    if (fs.existsSync(file)) {
      let disk; try { disk = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw Error("Settings are unreadable; existing Remote Access data was preserved"); }
      if (!disk || typeof disk !== "object" || Array.isArray(disk) || !isDeepStrictEqual(disk, ctx.core.settings.all())) throw Error("Settings changed outside Core. Restart to reload them safely");
      settingsExisted = true;
    } else if (settingsExisted) throw Error("Settings disappeared outside Core. Restart to reload them safely");
    const remote = ctx.core.settings.get("remote", {});
    if (!remote || typeof remote !== "object" || Array.isArray(remote)) throw Error("Saved remote keys need recovery; existing data was preserved");
    const keys = remote.pluginKeys === undefined ? {} : remote.pluginKeys, legacy = ctx.core.settings.get("apiKeys", {}), adopted = remote.pluginLegacyKeys === undefined ? [] : remote.pluginLegacyKeys;
    if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length > 100 || !legacy || typeof legacy !== "object" || Array.isArray(legacy) || !Array.isArray(adopted) || adopted.length > 100 || adopted.some(k => typeof k !== "string" || !/^key_[a-f0-9]{12}$/.test(k))) throw Error("Saved remote keys need recovery; existing data was preserved");
    for (const [id,k] of Object.entries(keys)) if (!/^rkey_[a-f0-9]{24}$/.test(id) || !k || typeof k.name !== "string" || k.name.length > 80 || !/^[a-f0-9]{64}$/.test(k.digest) || typeof k.createdAt !== "string") throw Error("Saved remote keys need recovery; existing data was preserved");
    if (remote.token !== undefined && (typeof remote.token !== "string" || !/^[a-f0-9]{64}$/.test(remote.token))) throw Error("Saved relay identity needs recovery; it was preserved");
    return { remote, keys, legacy, adopted };
  }
  function metadata() {
    const { keys, legacy, adopted } = checkSettings();
    return { keys: Object.entries(keys).map(([id,k]) => ({ id, name:k.name, createdAt:k.createdAt })), legacyKeys: Object.entries(legacy).filter(([id,k]) => /^key_[a-f0-9]{12}$/.test(id) && k && /^[a-f0-9]{64}$/.test(k.digest)).map(([id,k]) => ({ id, name:String(k.name || "Legacy API key").slice(0,80), enabled:adopted.includes(id) })) };
  }
  function verify(secret) {
    active(); if (mode() === "local-only" || typeof secret !== "string" || secret.length > 128) return null;
    const { keys, legacy, adopted } = checkSettings(), digest = crypto.createHash("sha256").update(secret).digest();
    for (const [id,k] of [...Object.entries(keys), ...Object.entries(legacy).filter(([id]) => adopted.includes(id))]) {
      if (!k || !/^[a-f0-9]{64}$/.test(k.digest)) continue;
      const saved = Buffer.from(k.digest, "hex"); if (crypto.timingSafeEqual(saved, digest)) return { id };
    }
    return null;
  }
  function models() { return ctx.core.models.aliases().filter(m => m.status === "ready").slice(0,256).map(({alias,label})=>({alias,label})); }
  function status() { const { remote } = checkSettings(); return { ...(tunnel?.status() || { enabled:false,state:"off",base:null,tunnelId:null,counts:{served:0,rejected:0} }), ...metadata(), privacyMode:mode(), relayUrl:RELAY, legacyEnabled:remote.enabled === true, models:models() }; }
  async function stop() {
    sessionRevision++; clearInterval(privacyTimer); privacyTimer = null;
    const running = tunnel; tunnel = null;
    if (running) stopping = Promise.resolve().then(() => running.stop());
    const drain = stopping;
    if (drain) { try { await drain; } finally { if (stopping === drain) stopping = null; } }
  }
  async function review(title,detail,signal) { if (!await ctx.confirm(title,detail)) return false; active(signal); checkSettings(); return true; }
  function clearCopiedKey() {
    clearTimeout(clipboardTimer); clipboardTimer = null;
    try { if (copiedKey && ctx.electron.clipboard.readText() === copiedKey) ctx.electron.clipboard.clear(); } catch {}
    copiedKey = null;
  }
  return {
    async call(method, value = {}, signal) {
      active(signal); if (!Object.hasOwn(permissions,method)) throw Error("Unknown Remote Access operation");
      if (method === "remote.status") { object(value); return status(); }
      if (method === "remote.keys") { object(value); return metadata(); }
      if (method === "remote.stop") { object(value); await stop(); return status(); }
      if (method === "remote.copyEndpoint") {
        object(value); const base=tunnel?.status().base; if (!base) throw Error("Start Remote Access and wait for a connected endpoint first");
        ctx.electron.clipboard.writeText(base); return { copied:true };
      }
      if (busy) throw Error("Finish the current Remote Access action first"); busy=true;
      try {
        checkSettings();
        if (method === "remote.start") {
          const revision = sessionRevision;
          object(value); if (tunnel?.status().enabled) return status();
          if (stopping) { await stopping; active(signal); if (revision !== sessionRevision) return {cancelled:true}; }
          if (mode() === "local-only") throw Error("Local-Only blocks Remote Access. Choose an online privacy mode in Core first.");
          const {keys,legacy,adopted}=checkSettings();
          if (!Object.keys(keys).length && !adopted.some(id=>legacy[id])) throw Error("Create a remote key or explicitly allow an existing API key first");
          if (!models().length) throw Error("Install a local model in Core first");
          if (!await review("Start Remote Access?",`Connect to ${RELAY} and let holders of your enabled remote API keys use installed local models?\n\nThe relay receives client API keys, prompts and responses. Only model listing and text chat are exposed. No Brain, files, accounts, wallet, network inference or paid services are exposed.\n\nAccess stops when this window closes, Core enters Local-Only, or you press Stop. It never starts automatically.`,signal)) return {cancelled:true};
          if (revision !== sessionRevision) return {cancelled:true};
          if(mode()==="local-only") throw Error("Local-Only blocks Remote Access");
          let token=ctx.core.settings.get("remote.token"); if(!token){token=crypto.randomBytes(32).toString("hex");ctx.core.settings.set("remote.token",token);}
          const Factory=ctx.remoteTunnelFactory || (options=>new RemoteTunnel(options));
          tunnel=Factory({token,verify,models,infer:(input,requestSignal)=>ctx.localInference(input,requestSignal),allowed:()=>!closed&&mode()!=="local-only"});
          try { await tunnel.start(); active(signal); if (revision !== sessionRevision) { await stop(); return {cancelled:true}; } }
          catch(error){await stop();throw error;}
          privacyTimer=setInterval(()=>{if(closed||mode()==="local-only")void stop().catch(()=>{});},250);privacyTimer.unref?.();
          return status();
        }
        if(method==="remote.rotate"){
          object(value);if(!await review("Replace your remote address?","Stop Remote Access and replace its relay identity? Existing client base URLs will stop working. API keys are retained. Start again and copy the new endpoint afterward.",signal))return{cancelled:true};
          await stop();active(signal);checkSettings();ctx.core.settings.set("remote.token",crypto.randomBytes(32).toString("hex"));return{rotated:true};
        }
        if(method==="remote.keyCreate"){
          const input=object(value,["name"]);if(typeof input.name!=="string"||!input.name.trim()||input.name.length>80||/[\r\n\0]/.test(input.name))throw Error("Give the key a name under 80 characters");
          if(Object.keys(checkSettings().keys).length>=50)throw Error("Revoke an unused key first; at most 50 remote keys can be saved");
          if(!await review("Create and copy a remote API key?",`Key: ${input.name.trim()}\n\nThis key will authorize only Remote Access model listing and local text inference while Remote Access is on. Core will copy the secret to your system clipboard once. Paste it into a trusted client; it cannot be recovered later. KAI clears it after 60 seconds if the clipboard is unchanged.`,signal))return{cancelled:true};
          const secret="kai_remote_"+crypto.randomBytes(32).toString("base64url"),id="rkey_"+crypto.randomBytes(12).toString("hex"),row={name:input.name.trim(),digest:crypto.createHash("sha256").update(secret).digest("hex"),createdAt:new Date().toISOString()};
          ctx.core.settings.set("remote.pluginKeys",{...checkSettings().keys,[id]:row});
          clearCopiedKey();
          try {ctx.electron.clipboard.writeText(secret);copiedKey=secret;clipboardTimer=setTimeout(clearCopiedKey,60000);clipboardTimer.unref?.();}
          catch{throw Error("The remote key was saved but clipboard copy failed. Revoke it and create another key.");}
          return{id,name:row.name,copied:true};
        }
        if(method==="remote.keyRevoke"){
          const input=object(value,["id"]),saved=checkSettings();if(typeof input.id!=="string"||!Object.hasOwn(saved.keys,input.id))throw Error("Unknown remote key");
          if(!await review("Revoke remote API key?",`Revoke ${saved.keys[input.id].name}? Remote Access will stop and active requests will be canceled. Other keys and existing gateway API keys remain unchanged.`,signal))return{cancelled:true};
          await stop();active(signal);const keys={...checkSettings().keys};delete keys[input.id];ctx.core.settings.set("remote.pluginKeys",keys);clearCopiedKey();return{revoked:true};
        }
        if(method==="remote.keyAdopt"){
          const input=object(value,["id","enabled"]),saved=checkSettings();if(typeof input.id!=="string"||!/^key_[a-f0-9]{12}$/.test(input.id)||!saved.legacy[input.id]||typeof input.enabled!=="boolean"||!/^[a-f0-9]{64}$/.test(saved.legacy[input.id].digest))throw Error("Choose an existing API key");
          if(!await review(input.enabled?"Allow this existing key remotely?":"Remove this key's remote access?",`${String(saved.legacy[input.id].name||"Existing API key").slice(0,80)}\n\n${input.enabled?"Existing clients holding this key may use local models through Remote Access when you start it. The secret is not read or copied by the plugin.":"This key will no longer work through Remote Access. Its original local gateway access and saved key record are preserved."}\n\nRemote Access stops while the allowlist changes.`,signal))return{cancelled:true};
          await stop();active(signal);const next=checkSettings();if(!next.legacy[input.id])throw Error("The existing key was removed elsewhere; refresh first");const selected=new Set(next.adopted);input.enabled?selected.add(input.id):selected.delete(input.id);ctx.core.settings.set("remote.pluginLegacyKeys",[...selected]);return{updated:true};
        }
      }finally{busy=false;}
    },
    async privacyChanged(privacyMode){if(privacyMode==="local-only")await stop();},
    async dispose(){closed=true;await stop();clearCopiedKey();},
  };
}
module.exports={pluginId,permissions,create};
