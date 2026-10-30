"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { OwnedConnection, cleanEnv } = require("../../electron/plugin-services/legacy-mcp-connection");
const { McpManager } = require("../lib/mcp-manager"), { ToolRegistry } = require("../lib/tools");

test("original manager accepts an owned transport without changing saved flags or tool discovery", async () => {
  const data = { "mcp.servers": [{ id: "saved", name: "Original tool", transport: "stdio", command: "synthetic", trusted: false, localSafe: false, autoConnect: true }] };
  const settings = { get: key => data[key], set: (key, value) => { data[key] = value; } }, registry = new ToolRegistry({ privacyMode: () => "local-first" }); let closed = 0;
  class Connection { constructor(config) { this.config = config; this.tools = [{ name: "inspect", description: "Original tool", inputSchema: { type: "object" } }]; } async connect() { return this.tools; } async callTool() { return "original result"; } close() { closed++; } }
  const manager = new McpManager({ settings, registry, Connection }); await manager.autoConnect();
  assert.equal(manager.servers()[0].connected, true); assert.equal(manager.servers()[0].autoConnect, true); assert.equal(registry.list()[0].sensitive, true);
  manager.setServerFlags("saved", { trusted: true, localSafe: true }); assert.equal(registry.list()[0].sensitive, false); assert.equal(registry.list()[0].egress, false);
  assert.equal(await registry.call(registry.list()[0].name, {}), "original result"); manager.closeAll(); assert.equal(closed, 1); assert.deepEqual(registry.list(), []);
});
test("owned stdio transport strips inherited secrets and closes its process tree", { timeout: 10000 }, async t => {
  const script = `
    const readline=require('node:readline'), cp=require('node:child_process');
    const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});
    readline.createInterface({input:process.stdin}).on('line',line=>{ const q=JSON.parse(line); if(!q.id)return;
      const result=q.method==='initialize'?{serverInfo:{name:'owned-fixture',childPid:child.pid,leaked:process.env.KAI_SYNTHETIC_SECRET||null}}:q.method==='tools/list'?{tools:[{name:'check',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'ok'}]};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
    });`;
  const connection = new OwnedConnection({ name: "Synthetic owned server", transport: "stdio", command: [process.execPath], args: ["-e", script], env: { ...process.env, KAI_SYNTHETIC_SECRET: "must-not-be-inherited" } });
  t.after(() => connection.close()); await connection.connect();
  assert.equal(connection.serverInfo.leaked, null); assert.equal(await connection.callTool("check", {}), "ok");
  const childPid = connection.serverInfo.childPid; assert.ok(Number.isInteger(childPid)); await connection.close();
  const running = () => {
    try { process.kill(childPid, 0); } catch { return false; }
    // The kernel delivers SIGKILL asynchronously; Linux init can then briefly
    // retain the already-dead orphan as a zombie. Bound the observation wait.
    if (process.platform === "linux") try { return !/^\d+ \(.+\) [ZX] /.test(fs.readFileSync(`/proc/${childPid}/stat`, "utf8")); } catch { return false; }
    return true;
  };
  let alive = running(); const deadline = Date.now() + 1000;
  while (alive && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 10)); alive = running(); }
  assert.equal(alive, false, "owned server descendant must not survive disconnect");
});
test("owned HTTP transport aborts an outstanding request on disconnect", async t => {
  let signal;
  t.mock.method(global, "fetch", async (_url, options) => { signal = options.signal; return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }); });
  const connection = new OwnedConnection({ name: "Synthetic HTTP server", transport: "http", url: "https://example.test/mcp" });
  const pending = connection._httpRpc("tools/list", {}), rejected = assert.rejects(pending, /abort/i);
  await connection.close(); await rejected; assert.equal(signal.aborted, true);
});
test("owned HTTP transport preserves original final SSE events without a trailing blank line", async t => {
  t.mock.method(global, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    const bytes = Buffer.from(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: "Final résumé" } })}`);
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, bytes.length - 3)); controller.enqueue(bytes.subarray(bytes.length - 3)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
  });
  const connection = new OwnedConnection({ name: "Synthetic SSE server", transport: "http", url: "https://example.test/mcp" });
  assert.deepEqual(await connection._httpRpc("tools/list", {}), { text: "Final résumé" });
  await connection.close();
});
test("owned MCP transports reject shell fallback and never propagate arbitrary environment keys", () => {
  assert.throws(() => new OwnedConnection({ transport: "stdio", command: "node.cmd", shell: true }), /without a shell/);
  assert.deepEqual(cleanEnv({ PATH: "/synthetic", HOME: "/synthetic-home", API_TOKEN: "private", NODE_OPTIONS: "--require bad" }), { PATH: "/synthetic", HOME: "/synthetic-home" });
});
