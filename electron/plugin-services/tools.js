"use strict";
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const { McpConnection, PROTOCOL_VERSION } = require("../../core/lib/mcp");
const { CATALOG } = require("../../core/lib/mcp-manager");
const { isDeepStrictEqual } = require("node:util");
const { NodeRuntime } = require("../../core/lib/node-runtime");
const pluginId = "kai.tools";
const permissions = Object.freeze({ "tools.status": "tools.read", "tools.catalog": "tools.read", "tools.add": "tools.manage", "tools.remove": "tools.manage", "tools.connect": "tools.manage", "tools.disconnect": "tools.manage", "tools.runtime": "tools.manage", "tools.call": "tools.execute" });
const cleanEnv = extra => Object.fromEntries(Object.entries(extra || process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(key)));
const object = (value, fields) => { if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 24000 || Object.keys(value).some(k => !fields.includes(k))) throw Error("Invalid tool request"); return structuredClone(value); };
const id = value => { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error("Invalid server ID"); return value; };
function validateConfig(value) {
  if (!value || !["http", "stdio"].includes(value.transport)) throw Error("Choose HTTP or a local process");
  const out = { name: String(value.name || "Tool server").slice(0, 60), transport: value.transport, localSafe: value.localSafe === true, trusted: false, autoConnect: false };
  if (out.transport === "http") {
    let u; try { u = new URL(value.url); } catch { throw Error("Enter a complete MCP server URL"); }
    if (u.username || u.password || u.hash || (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw Error("Use HTTPS, or localhost HTTP, without URL credentials or fragments");
    out.url = u.href;
  } else {
    const argv = Array.isArray(value.command) ? value.command : [value.command];
    if (argv.length !== 1 || typeof argv[0] !== "string" || !argv[0].trim() || argv[0].length > 2000 || /[\r\n\0]/.test(argv[0])) throw Error("Command must be one executable name or full path; put arguments in the argument list");
    if (!Array.isArray(value.args || []) || (value.args || []).length > 80 || (value.args || []).some(a => typeof a !== "string" || a.length > 2000 || /[\0\r\n]/.test(a))) throw Error("Use a JSON array of arguments, each shorter than 2,000 characters");
    out.command = argv; out.args = value.args || [];
  }
  return out;
}
// Local MCP programs are explicitly user-approved OS programs, not sandboxed
// plugins. Own a process group/tree, strip inherited secrets, and kill it when
// this plugin closes. Browser plugins never receive this process capability.
class OwnedConnection extends McpConnection {
  constructor(config) { super(config); this.abort = new AbortController(); this.done = Promise.resolve(); }
  _stdioStart() {
    const child = this._child = spawn(this.config.command[0], [...this.config.command.slice(1), ...(this.config.args || [])], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, env: cleanEnv(this.config.env), detached: process.platform !== "win32" });
    this.pid = child.pid;
    this.done = new Promise(resolve => child.once("close", resolve));
    const rejectAll = error => { for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(error); } this._pending.clear(); };
    const decoder = new (require("node:string_decoder").StringDecoder)("utf8");
    child.stdout.on("data", chunk => {
      this._buf += decoder.write(chunk);
      if (Buffer.byteLength(this._buf) > 2 * 1024 * 1024) { rejectAll(Error("MCP response exceeds 2 MB")); void this.close(); return; }
      let boundary;
      while ((boundary = this._buf.indexOf("\n")) >= 0) {
        const line = this._buf.slice(0, boundary).trim(); this._buf = this._buf.slice(boundary + 1);
        try { const message = JSON.parse(line), pending = this._pending.get(message.id); if (!pending) continue; clearTimeout(pending.timer); this._pending.delete(message.id); message.error ? pending.reject(Error("MCP operation failed")) : pending.resolve(message.result); } catch { /* ignore diagnostic lines */ }
      }
    });
    child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.on("error", () => { rejectAll(Error("The local tool server could not start. Check its executable and arguments.")); });
    child.on("exit", () => { this._child = null; rejectAll(Error("The local tool server stopped")); });
  }
  async _httpRpc(method, params, { notification = false, timeoutMs = 30000 } = {}) {
    const body = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(notification ? {} : { id: this._nextId++ }) };
    const response = await fetch(this.config.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this._sessionId ? { "mcp-session-id": this._sessionId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.min(timeoutMs, 60000))]) });
    const sessionId = response.headers.get("mcp-session-id"); if (sessionId) this._sessionId = sessionId;
    if (!response.ok) { await response.body?.cancel(); throw Error(`MCP server answered HTTP ${response.status}`); }
    if (notification) { await response.body?.cancel(); return null; }
    const sse = response.headers.get("content-type")?.includes("text/event-stream"); let text = "", bytes = 0, message;
    function parse(frame) { try { const value = JSON.parse(frame); return value.id === body.id ? value : null; } catch { return null; } }
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw Error("MCP response exceeds 2 MB"); text += decoder.decode(chunk, { stream: true });
      if (sse) { let split; while ((split = /\r?\n\r?\n/.exec(text))) { const frame = text.slice(0, split.index); text = text.slice(split.index + split[0].length); message = parse(frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")); if (message) break; } if (message) break; }
    }
    if (!sse) message = parse(text + decoder.decode());
    if (!message) throw Error("MCP response did not match the request"); if (message.error) throw Error("MCP operation failed"); return message.result;
  }
  close() {
    if (this.closing) return this.closing;
    this.abort.abort(); for (const p of this._pending.values()) { clearTimeout(p.timer); p.reject(Error("Tool server disconnected")); } this._pending.clear();
    const child = this._child, pid = this.pid; this._child = null; this.pid = null;
    this.closing = (async () => {
      if (pid) {
        if (process.platform === "win32") await new Promise(resolve => { const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore", env: cleanEnv() }); let timer; const done = () => { clearTimeout(timer); resolve(); }; killer.on("error", done); killer.on("close", done); timer = setTimeout(() => { killer.kill(); done(); }, 4000); timer.unref(); });
        else { try { process.kill(-pid, "SIGTERM"); } catch { try { child?.kill(); } catch {} } }
      }
      let timer; await Promise.race([this.done, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); clearTimeout(timer);
      if (pid && process.platform !== "win32") { try { process.kill(-pid, "SIGKILL"); } catch {} }
    })(); return this.closing;
  }
}
function create(ctx) {
  const connections = new Map(); let closed = false, busy = false, runtime;
  const mode = () => ctx.core.gateway.network.status().privacyMode;
  function settings() {
    const file = path.join(ctx.dataDir, "settings.json");
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat) { if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error("Settings need recovery; no tool records were changed"); let disk; try { disk = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw Error("Settings are unreadable; no tool records were changed"); }
      const current = ctx.core.settings.all();
      function unchanged(saved, memory) { if (!saved || typeof saved !== "object" || Array.isArray(saved)) return isDeepStrictEqual(saved, memory); return Object.entries(saved).every(([k,v]) => Object.hasOwn(memory || {}, k) && unchanged(v, memory[k])); }
      if (!unchanged(disk, current)) throw Error("Settings changed outside Core. Restart to reload safely; no tool records were changed");
    }
    const rows = ctx.core.settings.get("mcp.servers", []);
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(s => !s || typeof s.id !== "string")) throw Error("Saved tool servers need recovery"); return rows;
  }
  function node() { return runtime ||= new NodeRuntime({ provisioner: ctx.core.runtime.provisioner, runtimesDir: path.join(ctx.dataDir, "runtimes") }); }
  function list() { return settings().map(s => { let url = ""; try { const u = new URL(s.url); url = u.origin + u.pathname; } catch {} return { id: s.id, name: String(s.name || "Tool server").slice(0, 60), transport: s.transport, url, localSafe: s.localSafe === true, connected: connections.get(s.id)?.ready === true, tools: (connections.get(s.id)?.tools || []).slice(0, 256).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }; }); }
  const find = input => { const row = settings().find(s => s.id === id(input.id)); if (!row) throw Error("Unknown tool server"); return row; };
  const guard = (row, signal) => { signal?.throwIfAborted(); if (closed) throw Error("Tools is closed"); if (mode() === "local-only" && (row.transport !== "stdio" || !row.localSafe)) throw Error("Local-Only blocks this server. Use an online privacy mode, or explicitly mark a trusted local program as offline-safe."); };
  async function disconnect(serverId) { const conn = connections.get(serverId); connections.delete(serverId); if (conn) { clearInterval(conn.privacyTimer); await conn.close(); } }
  async function reviewed(title, detail, signal) { if (!await ctx.confirm(title, detail)) return false; signal?.throwIfAborted(); if (closed) throw Error("Tools is closed"); return true; }
  return {
    async call(method, value = {}, signal) {
      if (!Object.hasOwn(permissions, method)) throw Error("Unknown Tools operation"); if (closed) throw Error("Tools is closed"); signal?.throwIfAborted();
      if (method === "tools.status") return { privacyMode: mode(), servers: list(), protocolVersion: PROTOCOL_VERSION };
      if (method === "tools.catalog") return structuredClone(CATALOG);
      if (method === "tools.disconnect") { const input = object(value, ["id"]); await disconnect(id(input.id)); return { disconnected: true }; }
      if (busy) throw Error("Finish the current tool action first"); busy = true;
      try {
        if (method === "tools.runtime") {
          const input = object(value, ["install"]); if (!input.install) return node().status();
          if (mode() === "local-only") throw Error("Local-Only blocks runtime downloads");
          if (!await reviewed("Install Node runtime?", "Download the pinned Node runtime into KAI's existing runtime directory? This does not start a tool server or change your system installation.", signal)) return { cancelled: true };
          const result = await node().ensure(); signal?.throwIfAborted(); if (closed) throw Error("Tools is closed"); return result;
        }
        if (method === "tools.add") {
          const input = object(value, ["name", "transport", "url", "command", "args", "localSafe"]), config = validateConfig(input), rows = settings();
          if (rows.length >= 50) throw Error("Maximum 50 saved tool servers");
          if (!await reviewed("Save tool server?", `${config.name}\n${config.transport === "stdio" ? JSON.stringify(config.command.concat(config.args)) : config.url}\nSaving does not start this server. Each launch and tool call requires review.`, signal)) return { cancelled: true };
          const serverId = `srv${require("node:crypto").randomBytes(10).toString("hex")}`;
          ctx.core.settings.set("mcp.servers", [...settings(), { ...config, id: serverId }]); return { id: serverId };
        }
        if (method === "tools.remove") {
          const input = object(value, ["id"]), row = find(input);
          if (!await reviewed("Remove tool server?", `Disconnect and remove ${String(row.name).slice(0,60)}?`, signal)) return { cancelled: true };
          await disconnect(row.id); signal?.throwIfAborted(); if (closed) throw Error("Tools is closed"); ctx.core.settings.set("mcp.servers", settings().filter(s => s.id !== row.id)); return { removed: true };
        }
        if (method === "tools.connect") {
          const input = object(value, ["id"]), saved = find(input), row = validateConfig(saved); guard(row, signal);
          if (connections.get(saved.id)?.ready) return { connected: true };
          if (connections.has(saved.id)) await disconnect(saved.id);
          if (connections.size >= 4) throw Error("Disconnect another server first; at most four can run");
          if (!await reviewed("Start tool server?", row.transport === "stdio" ? `${row.name}\nExecutable and arguments: ${JSON.stringify(row.command.concat(row.args))}\n\nThis is a local OS program, not a sandboxed plugin. It can access files and the network as your user. Start only programs you trust. KAI will stop its process tree when Tools closes.` : `${row.name}\nConnect to ${row.url}? Tool inputs and outputs will pass through this endpoint.`, signal)) return { cancelled: true };
          guard(row, signal);
          let launch = row;
          if (row.transport === "stdio" && /^npx(?:\.cmd)?$/i.test(path.basename(row.command[0]))) {
            const resolved = node().resolveNpx(row.args); if (!resolved || resolved.shell) throw Error("A direct Node/npm runtime is required. Install Node runtime in Tools and retry.");
            launch = { ...row, command: [resolved.command], args: resolved.args, env: resolved.env };
          }
          const connection = new OwnedConnection(launch); connections.set(saved.id, connection);
          connection.privacyTimer = setInterval(() => { try { guard(row, signal); } catch { void disconnect(saved.id); } }, 250); connection.privacyTimer.unref?.();
          const onAbort = () => { void disconnect(saved.id); }; signal?.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(onAbort, 240000);
          try { await connection.connect(); guard(row, signal); if (connections.get(saved.id) !== connection || connection.tools.length > 256 || JSON.stringify(connection.tools).length > 200000) throw Error("Server discovery stopped or exceeds limits");
            if (connection.tools.some(t => typeof t.name !== "string" || t.name.length > 200 || !t.inputSchema || typeof t.inputSchema !== "object" || Array.isArray(t.inputSchema))) throw Error("Server returned invalid tool descriptions");
            connection.ready = true; if (connection._child) connection._child.once("exit", () => { connection.ready = false; if (connections.get(saved.id) === connection) void disconnect(saved.id); }); return { connected: true, tools: list().find(s => s.id === saved.id).tools }; }
          catch (error) { await disconnect(saved.id); throw error; }
          finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
        }
        if (method === "tools.call") {
          const input = object(value, ["id", "name", "args"]), row = find(input), conn = connections.get(row.id); guard(row, signal);
          if (!conn?.ready || typeof input.name !== "string" || !conn.tools.some(t => t.name === input.name)) throw Error("Connect the server and select an available tool");
          if (!input.args || typeof input.args !== "object" || Array.isArray(input.args) || JSON.stringify(input.args).length > 16000) throw Error("Tool arguments must be a JSON object under 16 KB");
          if (!await reviewed("Run tool?", `${row.name} · ${input.name}\n${JSON.stringify(input.args, null, 2)}\n\nThe tool runs with the permissions of its server. It may change data.`, signal)) return { cancelled: true };
          guard(row, signal); const abort = () => { void disconnect(row.id); }; signal?.addEventListener("abort", abort, { once: true });
          try { const result = await conn.callTool(input.name, input.args); signal?.throwIfAborted(); return { result: String(result).slice(0, 200000) }; }
          finally { signal?.removeEventListener("abort", abort); }
        }
      } finally { busy = false; }
    },
    async dispose() { closed = true; await Promise.all([...connections.keys()].map(disconnect)); },
  };
}
module.exports = { pluginId, permissions, create, validateConfig, cleanEnv };
