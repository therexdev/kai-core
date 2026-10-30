"use strict";
// Original engines, created only after a matching installed plugin requests
// its feature. This does not turn the old all-extensions switch back on.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const execution = new AsyncLocalStorage();
const hash = bytes => bytes === null ? null : crypto.createHash("sha256").update(bytes).digest("hex");
function guardedJSON(file, accepts, max = 16 * 1024 * 1024) {
  const directory = path.dirname(file), profile = fs.lstatSync(directory);
  if (!profile.isDirectory() || profile.isSymbolicLink()) throw Error("Feature storage must be a real directory");
  function bytes() {
    const current = fs.lstatSync(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== profile.dev || current.ino !== profile.ino) throw Error("Feature storage changed; saved data was preserved");
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw Error("Saved feature data is unsafe; original preserved");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { const open = fs.fstatSync(fd); if (open.dev !== stat.dev || open.ino !== stat.ino || open.size !== stat.size) throw Error("Feature data changed while opening"); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  }
  const initial = bytes(); let revision = hash(initial);
  if (initial) { let value; try { value = JSON.parse(initial); } catch { throw Error("Saved feature data is unreadable; original preserved"); } if (!accepts(value)) throw Error("Saved feature data has an invalid format; original preserved"); }
  function assert() { if (hash(bytes()) !== revision) throw Error("Saved feature data changed outside Core. Reopen the app before editing"); }
  return { assert, backup() { assert(); const content = bytes(); if (content) { const backup = file + ".plugin-backup-" + crypto.randomUUID(); fs.writeFileSync(backup, content, { flag: "wx", mode: 0o600 }); if (!fs.readFileSync(backup).equals(content)) throw Error("Feature backup could not be verified"); return backup; } return null; }, read() { assert(); return initial === null && revision === null ? null : JSON.parse(bytes()); }, write(value) {
    assert(); if (!accepts(value)) throw Error("Invalid feature data"); const data = Buffer.from(JSON.stringify(value, null, 2)); if (data.length > max) throw Error("Feature data exceeds its storage limit");
    const temp = file + "." + crypto.randomUUID() + ".tmp";
    try { fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 }); assert(); fs.renameSync(temp, file); revision = hash(data); } finally { fs.rmSync(temp, { force: true }); }
  } };
}

// Email/Calendar retain their original ENC1/PLN1 format and UI. Their old
// tolerant readers must not turn a locked or corrupt credential into an
// apparently empty account that a subsequent Save silently replaces.
function guardCredentials(service) {
  const file = service.file, directory = path.dirname(file), original = { load: service._load, save: service.saveConfig };
  const profile = fs.lstatSync(directory); let backedUp = false;
  function bytes() {
    const root = fs.lstatSync(directory); if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== profile.dev || root.ino !== profile.ino) throw Error("Account storage changed; original preserved");
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error("Saved account data is unsafe; original preserved");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try { const open = fs.fstatSync(fd); if (open.dev !== stat.dev || open.ino !== stat.ino || open.size !== stat.size) throw Error("Saved account changed while opening"); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  }
  let revision = hash(bytes());
  function assert() { if (hash(bytes()) !== revision) throw Error("Saved account changed outside Core; restart before changing it"); }
  function backup() { if (backedUp) return; const content = bytes(); if (content) { const backup = file + ".plugin-backup-" + crypto.randomUUID(); fs.writeFileSync(backup, content, { flag: "wx", mode: 0o600 }); if (!fs.readFileSync(backup).equals(content)) throw Error("Account backup could not be verified"); } backedUp = true; }
  service._load = function() {
    assert(); const saved = bytes(); if (!saved) return null;
    let value; try { const tag = saved.subarray(0, 4).toString(), payload = saved.subarray(4); value = JSON.parse(tag === "ENC1" ? this.safeStorage.decryptString(payload) : tag === "PLN1" ? payload.toString() : ""); } catch {}
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Unlock the original OS keychain or recover the saved account file. Its original data was preserved"); return value;
  };
  service.saveConfig = function(input) {
    service._load(); if (!service._encrypted()) throw Error("Unlock secure account storage before saving these credentials");
    const temp = file + "." + crypto.randomUUID() + ".tmp", staged = Object.assign(Object.create(Object.getPrototypeOf(service)), service, { file: temp });
    delete staged._load; delete staged.saveConfig; delete staged.removeConfig;
    try { const result = original.save.call(staged, input); assert(); backup(); assert(); fs.renameSync(temp, file); revision = hash(bytes()); return result; } finally { fs.rmSync(temp, { force: true }); }
  };
  service.removeConfig = () => { service._load(); assert(); backup(); fs.rmSync(file, { force: true }); revision = null; };
  return service;
}

// Import the old scheduled prompts through the original migration protocol,
// without starting a second scheduler beside Workflows.
function legacyTaskMigration(dataDir) {
  const file = path.join(dataDir, "tasks.json"), accepts = value => value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.tasks) && value.tasks.every(task => task && typeof task.id === "string" && typeof task.name === "string" && typeof task.prompt === "string" && typeof task.model === "string" && ["hourly", "every6h", "daily", "weekly"].includes(task.schedule?.kind));
  const guard = guardedJSON(file, accepts), original = guard.read() || { tasks: [] };
  const runner = new (require("../../core/lib/tasks").TaskRunner)({ file, runChat: async () => { throw Error("Scheduled prompts now run through Workflows"); } });
  runner.tasks = structuredClone(original.tasks); let backedUp = false;
  runner._persist = () => { guard.assert(); if (!backedUp) { guard.backup(); backedUp = true; } guard.write({ ...original, tasks: runner.tasks }); };
  return {
    list() { guard.assert(); return runner.list(); },
    migrateToWorkflow(id, workflowId) {
      guard.assert(); const before = structuredClone(runner.tasks);
      try { return runner.migrateToWorkflow(id, workflowId); } catch (error) { runner.tasks = before; throw error; }
    },
  };
}

function createLegacyCoreServices({ core, dataDir, provisioner, events = () => {} }) {
  const gateway = core.gateway, owned = new Set(); let closed = false, builtins = false;
  const controllers = new Set();
  const chat = async ({ model, messages, maxTokens, signal, privateDesktop = false }) => {
    if (closed) throw Error("Plugin services are closing"); const controller = new AbortController(); controllers.add(controller);
    try {
      const inherited = execution.getStore()?.signal;
      const response = await fetch(`http://127.0.0.1:${gateway.port}/core/chat/completions`, { method: "POST", signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : []), ...(inherited ? [inherited] : [])]),
        headers: { "content-type": "application/json", ...(process.env.KAI_CORE_TOKEN ? { authorization: `Bearer ${process.env.KAI_CORE_TOKEN}` } : {}) },
        body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens, ...(privateDesktop ? { kai_private_desktop: true } : {}) }) });
      const body = await response.json(); if (!response.ok) throw Error(body?.error?.message || "Model request failed"); return body?.choices?.[0]?.message?.content || "";
    } finally { controllers.delete(controller); }
  };
  function common() {
    if (builtins) return; builtins = true;
    if (!gateway.nodeRuntime) gateway.nodeRuntime = new (require("../../core/lib/node-runtime").NodeRuntime)({ provisioner, runtimesDir: path.join(dataDir, "runtimes") });
    require("../../core/lib/builtin-tools").registerBuiltinTools(gateway.tools, { dataDir, nodeRuntime: gateway.nodeRuntime });
    const toolCall = gateway.tools.call.bind(gateway.tools);
    gateway.tools.call = (name, args, options = {}) => { const inherited = execution.getStore()?.signal; return toolCall(name, args, { ...options, ...(inherited ? { signal: AbortSignal.any([inherited, ...(options.signal ? [options.signal] : [])]) } : {}) }); };
  }
  function developer() {
    if (!gateway.dev) gateway.dev = { status: () => ({ enabled: core.settings.get("dev.tools", false) === true }), configure: ({ enabled }) => { core.settings.set("dev.tools", enabled === true); return gateway.dev.status(); } };
    if (!gateway.teams) gateway.teams = new (require("../../core/lib/teams").TeamRunner)({ registry: gateway.tools, onEvent: events, chatFn: chat });
    if (!gateway.agents) {
      const { GroupChatRunner, GroupDefs } = require("../../core/lib/groupchat"), file = path.join(dataDir, "agent-teams.json"), guard = guardedJSON(file, Array.isArray);
      const defs = new GroupDefs(file); defs._read = () => guard.read() || []; defs._write = value => guard.write(value);
      gateway.agents = { runner: new GroupChatRunner({ registry: gateway.tools, onEvent: events, chatFn: chat }), defs, registry: gateway.tools };
    }
  }
  function ensure(feature) {
    if (closed) throw Error("Plugin services are closing");
    if (!["assistant", "tools", "model-compare", "code", "documents", "brain", "connections", "workflows", "remote-access"].includes(feature)) throw Error("Unknown optional feature");
    if (owned.has(feature) && !(feature === "assistant" && (gateway.speech?.closed || gateway.turn?.closed))) return gateway;
    if (["assistant", "tools", "model-compare", "code"].includes(feature)) common();
    if (["assistant", "tools", "model-compare"].includes(feature)) developer();
    if (["tools", "model-compare"].includes(feature) && !gateway.bench) gateway.bench = new (require("../../core/lib/bench").BenchRunner)({ chatFn: chat, teams: gateway.teams, dataDir });
    if (feature === "workflows" && !core.legacyTasks) core.legacyTasks = legacyTaskMigration(dataDir);
    if (feature === "brain" && !gateway.memory) {
      const guard = guardedJSON(path.join(dataDir, "memory.json"), Array.isArray);
      gateway.memory = new (require("../../core/lib/memory").MemoryStore)(dataDir);
      let backedUp = false;
      gateway.memory._save = () => { if (!backedUp) { guard.backup(); backedUp = true; } guard.write(gateway.memory.items); gateway.memory._index = null; };
    }
    if (feature === "code" && !gateway.code) {
      const projectsGuard = guardedJSON(path.join(dataDir, "code-projects.json"), Array.isArray), githubGuard = guardedJSON(path.join(dataDir, "github.json"), v => v && typeof v === "object" && !Array.isArray(v));
      const code = new (require("../../core/lib/code-agent").CodeAgent)({ chatFn: input => chat({ ...input, privateDesktop: true }), registry: gateway.tools, onEvent: events });
      code.projects = new (require("../../core/lib/code-projects").CodeProjects)(dataDir); code.projects._save = () => projectsGuard.write(code.projects.projects);
      code.github = new (require("../../core/lib/github").GitHub)(dataDir); code.github._save = () => githubGuard.write(code.github.data);
      for (const [service, guard] of [[code.projects, projectsGuard], [code.github, githubGuard]]) for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(service))) {
        if (name === "constructor" || name === "_save" || typeof service[name] !== "function") continue;
        const method = service[name]; service[name] = function(...args) { guard.assert(); return method.apply(this, args); };
      }
      // Installing/enabling Code is the new feature switch. Do not overwrite
      // the old application's saved switch just because its plugin opens.
      let enabled = true;
      code.switch = { status: () => ({ enabled }), configure: input => { enabled = input.enabled === true; return code.switch.status(); } };
      code._pluginApprovals = new Map(); const ask = code._ask.bind(code);
      code._ask = (runId, detail, trace) => ask(runId, detail, entry => { code._pluginApprovals.set(entry.approvalId, structuredClone(entry)); trace(entry); });
      const approve = code.provideApproval.bind(code); code.provideApproval = (id, allowed) => { const result = approve(id, allowed); code._pluginApprovals.delete(id); return result; };
      gateway.code = code;
    }
    if (feature === "code") gateway.code.switch.configure({ enabled: true });
    if (feature === "tools") {
      let safeStorage; try { safeStorage = require("electron").safeStorage; } catch {}
      if (!gateway.mcp) {
        const { OwnedConnection } = require("./legacy-mcp-connection"), closing = new Set();
        class TrackedConnection extends OwnedConnection {
          constructor(config, onEvent) { super(config, event => { onEvent(event); if (event.type === "mcp:exited" && gateway.mcp?._conns.get(config.id) === this) gateway.mcp.disconnect(config.id); }); }
          close() { const task = super.close(); closing.add(task); task.finally(() => closing.delete(task)); return task; }
        }
        gateway.mcp = new (require("../../core/lib/mcp-manager").McpManager)({ settings: core.settings, registry: gateway.tools, nodeRuntime: gateway.nodeRuntime, onEvent: events, Connection: TrackedConnection });
        const connect = gateway.mcp.connect.bind(gateway.mcp);
        const permitted = server => gateway.network?.status().privacyMode !== "local-only" || server?.transport === "stdio" && server.localSafe === true;
        gateway.mcp.connect = async id => {
          const server = (core.settings.get("mcp.servers") || []).find(server => server.id === id);
          if (server && !permitted(server)) throw Error("Local-Only blocks this tool server. Only local programs marked offline-safe may run.");
          return connect(id);
        };
        gateway.mcp.closeUnavailable = async () => {
          for (const server of core.settings.get("mcp.servers") || []) if (!permitted(server)) gateway.mcp.disconnect(server.id);
          await Promise.allSettled([...closing]);
        };
        const closeAll = gateway.mcp.closeAll.bind(gateway.mcp);
        gateway.mcp.closeAll = async () => { closeAll(); await Promise.allSettled([...closing]); };
      }
      if (!gateway.email) { const { EmailService, registerEmailTools } = require("../../core/lib/email"); gateway.email = guardCredentials(new EmailService({ dataDir, safeStorage, onEvent: events })); registerEmailTools(gateway.tools, gateway.email); }
      if (!gateway.calendar) { const { CalendarService, registerCalendarTools } = require("../../core/lib/caldav"); gateway.calendar = guardCredentials(new CalendarService({ dataDir, safeStorage, onEvent: events })); registerCalendarTools(gateway.tools, gateway.calendar); }
    }
    if (feature === "assistant") {
      if (!gateway.voice) gateway.voice = new (require("../../core/lib/whisper").VoiceManager)({ provisioner, catalogPath: path.join(__dirname, "../../core/runtimes/catalog.json"), voiceDir: path.join(dataDir, "voice"), onEvent: events });
      if (!gateway.speech || gateway.speech.closed) gateway.speech = new (require("../../core/lib/speech").SpeechManager)({ speechDir: path.join(dataDir, "voice/kokoro") });
      if (!gateway.turn || gateway.turn.closed) gateway.turn = new (require("../../core/lib/smart-turn").SmartTurnManager)({ modelPath: require("../../core/lib/live-senses-assets").smartTurnModelPath() });
    }
    owned.add(feature); return gateway;
  }
  async function dispose() {
    closed = true; for (const c of controllers) c.abort();
    for (const id of gateway.code?._runs?.keys() || []) gateway.code.stop(id);
    for (const id of gateway.agents?.runner?._runs?.keys() || []) gateway.agents.runner.stop?.(id);
    await gateway.mcp?.closeAll?.(); await gateway.speech?.close?.(); await gateway.turn?.close?.();
  }
  return { ensure, dispose, owned, release: feature => owned.delete(feature) };
}
module.exports = { createLegacyCoreServices, guardedJSON, guardCredentials, legacyTaskMigration, runWithLegacySignal: (signal, fn) => execution.run({ signal }, fn) };
