"use strict";
// Adapter for the original coding workspace. The original CodeAgent, project
// store, GitHub client and gateway handlers remain the implementation.
const path = require("node:path"), fs = require("node:fs");
const STATIC = new Map([
  ["/core/models", ["GET"]], ["/core/code-switch", ["GET", "POST"]],
  ["/core/code/projects", ["GET", "POST"]], ["/core/code/browse", ["POST"]],
  ["/core/code/commands", ["POST"]], ["/core/code/tools", ["GET"]],
  ["/core/code/github", ["GET"]], ["/core/code/github/repos", ["GET"]],
  ...["connect","disconnect","clone","status","branch","commit","push","pr"].map(name => ["/core/code/github/"+name,["POST"]]),
  ...["approve","stop","run"].map(name=>["/core/code/"+name,["POST"]]),
]);
function route(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.path !== "string" || typeof input.method !== "string") throw Error("Invalid coding workspace request");
  const p = input.path, m = input.method;
  if (p.includes("?") || p.includes("#") || p.includes("\\") || p.includes("%") || p.includes("..")) throw Error("Invalid coding workspace route");
  let methods = STATIC.get(p);
  if (!methods && /^\/core\/code\/projects\/[a-zA-Z0-9_-]+$/.test(p)) methods = ["PATCH","DELETE"];
  if (!methods && /^\/core\/code\/projects\/[a-zA-Z0-9_-]+\/sessions$/.test(p)) methods = ["GET","POST"];
  if (!methods && /^\/core\/code\/projects\/[a-zA-Z0-9_-]+\/sessions\/[a-zA-Z0-9_-]+$/.test(p)) methods = ["GET","DELETE"];
  if (!methods?.includes(m)) throw Error("Unsupported coding workspace operation");
  if (input.body !== undefined && (!input.body || typeof input.body !== "object" || Array.isArray(input.body))) throw Error("Coding workspace body must be an object");
  return {path:p,method:m,body:input.body,stream:p==="/core/code/run"};
}
function create(ctx) {
  let closed = false;
  const roots = new Map();
  function active(signal) { signal?.throwIfAborted(); if(closed)throw Error("Code plugin is closed"); }
  async function confirm(title, detail, signal) { active(signal);const approved=await ctx.confirm(title,detail);active(signal);if(!approved)throw Error("Cancelled. Nothing was changed."); }
  async function ensure(signal) { await ctx.legacyEnsure?.("code");active(signal); }
  function project(id) { const projects=ctx.core?.gateway?.code?.projects;if(!projects)throw Error("Coding workspace is not ready");return projects.get(String(id||"")); }
  async function authorizeRoot(dir, signal) {
    const root = require("./code").projectRoot(dir,ctx.dataDir);
    const granted = roots.get(root.dir);
    if (!granted || granted.dev !== root.dev || granted.ino !== root.ino) { await confirm("Open coding project",`Allow Koinos Code to read this project and propose changes?\n\n${root.dir}\n\nEvery edit and command still requires its own approval.`,signal);active(signal);const after=require("./code").projectRoot(dir,ctx.dataDir);if(after.dev!==root.dev||after.ino!==root.ino)throw Error("Project folder changed during review");roots.set(root.dir, root); }
    return root.dir;
  }
  return {
    async call(method,input={},signal) {
      active(signal);
      if(method==="code.poll")return ctx.legacyPoll("code",input.streamId,signal);
      if(method==="code.cancel")return ctx.legacyCancel("code",input.streamId);
      if(method==="code.chooseFolder") {
        const result=await ctx.electron.dialog.showOpenDialog(ctx.getWindow(),{title:String(input.title||"Choose a project folder").slice(0,160),properties:["openDirectory"]});active(signal);
        if(result.canceled||result.filePaths.length!==1)return null;
        const dir=fs.realpathSync(result.filePaths[0]), info=fs.lstatSync(dir);if(!info.isDirectory())throw Error("Choose a directory");roots.set(dir,{dir,dev:info.dev,ino:info.ino});return dir;
      }
      if(method!=="code.request")throw Error("Unknown coding workspace operation");
      const request=route(input),body=request.body||{},p=request.path;
      await ensure(signal);
      if(p==="/core/code-switch"&&request.method==="POST") {
        if(Object.keys(body).length!==1 || typeof body.enabled!=="boolean")throw Error("Coding workspace switch requires an exact enabled boolean");
        const control=ctx.core.gateway.code?.switch;if(!control)throw Error("Coding workspace switch is unavailable");
        const before=control.status().enabled,enabled=body.enabled;
        await confirm(enabled?"Enable coding workspace?":"Disable coding workspace?",`Set Koinos Code to ${enabled?"on":"off"} for this Core session. Every project, edit and command keeps its existing approval.`,signal);
        if(ctx.core.gateway.code?.switch!==control || control.status().enabled!==before)throw Error("Coding workspace switch changed during review. Review it again.");
        request.body={enabled};
      }
      if(p==="/core/code/projects"&&request.method==="POST")await authorizeRoot(body.dir,signal);
      if(p==="/core/code/run") {
        if(!body.projectId || body.dir)throw Error("Choose a saved project before starting a coding task");
        const selected=project(body.projectId);await authorizeRoot(selected.path,signal);
        const ready=ctx.core.models.aliases().filter(model=>model.status==="ready"&&!/^(?:desktop:|koinos-network)/.test(model.alias));
        const explicit=String(body.model||"").trim(), saved=ready.some(model=>model.alias===selected.model)?selected.model:null, active=ctx.core.gateway.runtime?.status?.().activeAlias;
        const model=explicit||saved||(ready.some(model=>model.alias===active)?active:ready[0]?.alias);
        if(!model||!ready.some(row=>row.alias===model))throw Error("Choose an installed local model for private source code");
        request.body={...body,model};
      }
      const operation=p.slice("/core/code/github/".length);
      if(p.startsWith("/core/code/github/")&&["connect","repos","clone","push","pr"].includes(operation)&&ctx.core.gateway.network.status().privacyMode==="local-only")throw Error("GitHub is unavailable in Local-Only mode");
      if(p==="/core/code/github/clone") {
        const parent=fs.realpathSync(String(body.parentDir||"")), before=fs.lstatSync(parent);
        const {parseRepo,cloneTarget}=require("../../core/lib/git"), repo=parseRepo(body.repo), target=cloneTarget(parent,repo.repo), privateRoot=path.dirname(path.resolve(ctx.dataDir));
        if(target===privateRoot || target.startsWith(privateRoot+path.sep) || privateRoot.startsWith(target+path.sep))throw Error("KAI private profile cannot contain coding repositories");
        await confirm("Clone GitHub repository",`Clone ${repo.full} into ${target}?`,signal);
        const after=fs.lstatSync(parent);if(!after.isDirectory()||after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino)throw Error("Clone destination changed during review");
        request.body={...body,parentDir:parent,repo:repo.full};
      }
      if(p.startsWith("/core/code/github/")&&["branch","commit","push","pr"].includes(operation)) {
        const selected=project(body.projectId);await authorizeRoot(selected.path,signal);
        const detail=operation==="branch"?String(body.name||""):operation==="commit"?String(body.message||""):operation==="pr"?`${String(body.title||"")}\n\n${String(body.body||"")}\nBase: ${String(body.base||"default")}`:"Push the current branch to its configured remote.";
        await confirm(({branch:"Create Git branch",commit:"Commit project changes",push:"Push to GitHub",pr:"Open GitHub pull request"})[operation],`${selected.name}\n${selected.path}\n\n${detail}`,signal);
      }
      return ctx.legacyRequest("code",request,signal);
    },
    async dispose() { closed=true;roots.clear();await ctx.legacyRelease?.("code"); }
  };
}
module.exports={create,route};
