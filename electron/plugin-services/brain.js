"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { CompanionBrain, digest } = require("../companion-brain");
const { CompanionSources } = require("../companion-sources");
const { id } = require("../companion-store");
const permissions = { "brain.list": "brain.read", "brain.get": "brain.read", "brain.search": "brain.read", "brain.save": "brain.write", "brain.remove": "brain.write", "brain.goals": "brain.read", "brain.goalSave": "brain.write", "brain.goalRemove": "brain.write", "brain.sources": "brain.read", "brain.sourceImport": "brain.import", "brain.sourceRemove": "brain.write", "brain.export": "brain.export" };
function inspect(file) {
  try { const s = fs.lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.size > 36 * 1024 * 1024) throw Error("Brain data must be a regular, bounded file. Existing data was not changed."); const j = JSON.parse(fs.readFileSync(file, "utf8")); if (j.version !== 1 || typeof j.encrypted !== "string") throw Error("Brain data is unreadable. Existing data was not changed."); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
}
function record(value) { if (!value) throw Error("This item no longer exists."); return { ...structuredClone(value), revision: digest(JSON.stringify(value)) }; }
function requireRevision(value, revision) { if (!value || typeof revision !== "string" || digest(JSON.stringify(value)) !== revision) throw Error("This item changed. Reload it before saving."); }
function bounded(value, max, label, empty = false) { if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) throw Error(`${label} must be text, up to ${max} characters.`); return value; }
function checkRoot(dataDir) { const st = fs.lstatSync(dataDir); if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Profile must be a real directory."); }
function create(ctx) {
  let brain, sources, store;
  function access() { checkRoot(ctx.dataDir); inspect(path.join(ctx.dataDir, "companion-hub.json")); store = ctx.getCompanionStore(); store.requireStorage(); brain ||= new CompanionBrain({ store }); sources ||= new CompanionSources({ store, chats: ctx.core.gateway.chats, privacyMode: () => "local-only" }); return store; }
  const notes = () => store.data.notes;
  return { async call(method, input = {}, signal) {
    signal?.throwIfAborted(); if (!Object.hasOwn(permissions, method)) throw Error("Unknown Brain operation."); access();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("Invalid Brain request.");
    if (method === "brain.list" || method === "brain.search") {
      const query = bounded(input.query ?? "", 2000, "Search", true);
      const result = brain.search({ query }).map(n => ({ id: n.id, title: n.title, category: n.category, tags: n.tags, source: n.source, sourceId: n.sourceId || null, pinned: n.pinned, updatedAt: n.updatedAt, excerpt: n.text.slice(0, 300) }));
      return { notes: result, total: notes().length, metrics: { notes: notes().length, goals: store.data.goals.length, sources: store.data.sources.length }, limited: notes().length > result.length };
    }
    if (method === "brain.get") return record(notes().find(n => n.id === input.id));
    if (method === "brain.save") {
      const old = input.id ? notes().find(n => n.id === input.id) : null;
      if (input.id) { requireRevision(old, input.revision); if (old.sourceId) throw Error("Imported source content is read-only. Re-import its source instead."); }
      const next = { ...(old || {}), title: bounded(input.title, 120, "Title"), text: bounded(input.text, 12000, "Memory"), category: input.category || old?.category || "notes", pinned: input.pinned === true, tags: input.tags || [] };
      return record(store.note(next));
    }
    if (method === "brain.remove") {
      const old = notes().find(n => n.id === input.id); requireRevision(old, input.revision);
      if (old.sourceId) throw Error("Remove the imported source to forget its content.");
      if (!await ctx.confirm("Forget this memory?", `Remove “${old.title}” from your personal Brain? This also removes its derived recall history.`)) return { cancelled: true };
      signal?.throwIfAborted(); access(); requireRevision(notes().find(n => n.id === input.id), input.revision); store.remove("notes", input.id); return { removed: true };
    }
    if (method === "brain.goals") return { goals: store.data.goals.map(record) };
    if (method === "brain.goalSave") {
      const old = input.id ? store.data.goals.find(g => g.id === input.id) : null; if (input.id) requireRevision(old, input.revision);
      return record(store.goal({ ...(old || {}), title: bounded(input.title, 200, "Goal"), detail: bounded(input.detail ?? "", 2000, "Detail", true), status: input.status || "active", priority: input.priority || "normal" }));
    }
    if (method === "brain.goalRemove") {
      const old = store.data.goals.find(g => g.id === input.id); requireRevision(old, input.revision);
      if (!await ctx.confirm("Remove this goal?", `Remove “${old.title}” from Brain?`)) return { cancelled: true };
      signal?.throwIfAborted(); access(); requireRevision(store.data.goals.find(g => g.id === input.id), input.revision); store.remove("goals", input.id); return { removed: true };
    }
    if (method === "brain.sources") return { sources: store.data.sources.map(s => ({ id: s.id, name: s.name, kind: s.kind, lastSync: s.lastSync, chunks: s.chunks || notes().filter(n => n.sourceId === s.id).length, revision: digest(JSON.stringify(s)), error: s.error ? "The last source sync did not complete." : null })) };
    if (method === "brain.sourceImport") {
      const folder = input.kind === "folder";
      const chosen = await ctx.electron.dialog.showOpenDialog(ctx.getWindow(), { title: folder ? "Import a folder snapshot into Brain" : "Import a text source into Brain", properties: [folder ? "openDirectory" : "openFile"], ...(folder ? {} : { filters: [{ name: "Text source", extensions: ["txt", "md", "csv", "json"] }] }) });
      signal?.throwIfAborted(); if (chosen.canceled) return { cancelled: true };
      const file = chosen.filePaths[0], st = fs.lstatSync(file); let content;
      if (folder) {
        if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Choose a real directory.");
        content = sources.readFolder({ folder: fs.realpathSync(file), extensions: ["md", "txt", "csv", "json"], recursive: false }, signal);
      } else {
      if (!st.isFile() || st.isSymbolicLink() || st.size > 200000 || !/\.(txt|md|csv|json)$/i.test(file)) throw Error("Choose a regular text file smaller than 200 KB.");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { const current = fs.fstatSync(fd); if (current.ino !== st.ino || current.dev !== st.dev || current.size > 200000) throw Error("Selected file changed."); content = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
      }
      if (!content.trim() || content.includes("\0") || content.length > 200000) throw Error("Choose a nonempty text file smaller than 200 KB.");
      access(); const sourceId = id(), name = path.basename(file).slice(0, 100);
      if (store.data.sources.length >= 100 || notes().length + Math.ceil(content.length / 3000) > 3000) throw Error("Brain is full. Remove older sources first.");
      store.change(d => { d.sources.push({ id: sourceId, kind: "file", name, autoSync: false, lastSync: null }); });
      const result = store.ingest(sourceId, content); return { sourceId, name, ...result };
    }
    if (method === "brain.sourceRemove") {
      const old = store.data.sources.find(s => s.id === input.id); requireRevision(old, input.revision);
      if (!await ctx.confirm("Forget this source?", `Remove “${old.name}” and the memories imported from it? Its original external file or account remains untouched.`)) return { cancelled: true };
      signal?.throwIfAborted(); access(); requireRevision(store.data.sources.find(s => s.id === input.id), input.revision); store.remove("sources", input.id); return { removed: true };
    }
    if (method === "brain.export") {
      const chosen = await ctx.electron.dialog.showSaveDialog(ctx.getWindow(), { title: "Export private Brain as Markdown", defaultPath: "KAI-Brain.md", filters: [{ name: "Markdown", extensions: ["md"] }] });
      signal?.throwIfAborted(); if (chosen.canceled || !chosen.filePath) return { cancelled: true };
      access(); const file = chosen.filePath; if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw Error("Choose a regular output file.");
      const temp = file + "." + crypto.randomUUID() + ".tmp";
      try { fs.writeFileSync(temp, store.markdown(), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
      return { exported: true, name: path.basename(file) };
    }
  } };
}
module.exports = { pluginId: "kai.brain", permissions, create };
