"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), { execFile } = require("node:child_process");
const { NodeManager, buildEnv, composeForMacos } = require("../../core/lib/koinos/node-manager");
const { assertRestoreReady } = require("../../core/lib/koinos/node-maintenance");
const { inspectOwner } = require("../../core/lib/koinos/node-control");
const { SetupService } = require("../../core/lib/koinos/setup");
const { NETWORKS } = require("../../core/lib/koinos/constants");
const { DOCKER_DOCS } = require("../../core/lib/koinos/setup-plan");
const pluginId = "kai.koinos-node";
const permissions = Object.freeze({ "node.status":"koinos-node.read", "node.inspect":"koinos-node.manage", "node.logs":"koinos-node.read", "node.configure":"koinos-node.manage", "node.start":"koinos-node.manage", "node.stop":"koinos-node.manage", "node.setup":"koinos-node.manage" });
const services = new Set(["amqp","chain","mempool","block_store","block_producer","p2p","jsonrpc","grpc","rest","transaction_store"]);
const templateRoot = path.join(__dirname,"../../core/koinos-node-template");
const plain = value => value && typeof value === "object" && !Array.isArray(value);
function input(value, allowed) { if (!plain(value) || JSON.stringify(value).length > 4000 || Object.keys(value).some(k=>!allowed.includes(k))) throw Error("Invalid node request"); return structuredClone(value); }
function safePath(target, file = false, max = 2 * 1024 * 1024) {
  const absolute = path.resolve(target), root = path.parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); let st; try { st = fs.lstatSync(current); } catch(e) { if (e.code === "ENOENT") continue; throw e; }
    const isFile = file && current === absolute;
    if (st.isSymbolicLink() || (isFile ? !st.isFile() || st.nlink !== 1 || st.size > max : !st.isDirectory())) throw Error("Node storage is unsafe or too large; original data was preserved");
  }
}
function readFile(file, max) { safePath(file,true,max); try { return fs.readFileSync(file); } catch(e) { if(e.code==="ENOENT")return null;throw e; } }
const hash = bytes => bytes ? crypto.createHash("sha256").update(bytes).digest("hex") : null;
function redact(value) {
  return String(value ?? "").replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,"[private key redacted]")
    .replace(/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g,"[private key redacted]")
    .replace(/((?:password|passwd|secret|token|private[_ -]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi,"$1[redacted]")
    .replace(/\b(?:[a-f\d]{64,}|[A-Za-z\d+/]{80,}={0,2})\b/gi,"[long value redacted]").slice(-64000);
}
// Unlike the legacy JsonStore constructor, this never restores or rewrites a
// corrupt primary merely because a plugin was opened. Unrelated fields survive.
class GuardedStore {
  constructor(file) { this.file=file; const bytes=readFile(file); this.digest=hash(bytes); try { this.data=bytes ? JSON.parse(bytes) : {}; } catch { throw Error("Saved node settings are unreadable; original data was preserved"); }
    if(!plain(this.data))throw Error("Saved node settings need recovery");
    if(!bytes && readFile(file+".last-good"))throw Error("Node settings primary is missing. Restore its backup deliberately before using Node");
  }
  assert() { if(hash(readFile(this.file))!==this.digest)throw Error("Node settings changed outside Core. Close and reopen this plugin before editing"); }
  get(key,fallback) { const value=key.split(".").reduce((o,k)=>plain(o)&&Object.hasOwn(o,k)?o[k]:undefined,this.data);return value===undefined?fallback:value; }
  set(key,value) { this.assert();const next=structuredClone(this.data),parts=key.split("."); if(parts.some(k=>["__proto__","constructor","prototype"].includes(k)))throw Error("Invalid node settings key");let row=next;for(const k of parts.slice(0,-1)){if(!plain(row[k]))row[k]={};row=row[k];}row[parts.at(-1)]=value;
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const previous=readFile(this.file); if(previous){ const backup=this.file+".core-backup-"+Date.now()+"-"+crypto.randomBytes(4).toString("hex");fs.writeFileSync(backup,previous,{flag:"wx",mode:0o600});if(!fs.readFileSync(backup).equals(previous))throw Error("Node configuration backup failed"); }
    const bytes=Buffer.from(JSON.stringify(next,null,2)),temp=this.file+"."+crypto.randomBytes(8).toString("hex")+".tmp";try{fs.writeFileSync(temp,bytes,{flag:"wx",mode:0o600});this.assert();fs.renameSync(temp,this.file);}finally{fs.rmSync(temp,{force:true});}this.data=next;this.digest=hash(bytes);
  }
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(k)));
function nativeRuntime({dataRoot,intentPath,state,assertActive,assertFiles,onStartIntent=()=>{},exec=execFile}) {
  const children=new Set(),cleanupChildren=new Set(); let closing=false, cleanup=false;
  function run(bin,args,opts={}) {
    if(!cleanup)assertActive();
    return new Promise(resolve=>{
      let env=cleanEnv();
      if(/^(docker|docker-compose)(?:\.exe)?$/i.test(path.basename(bin))){
        const home=require("node:os").homedir();let host="unix:///var/run/docker.sock";
        if(process.platform==="win32")host="npipe:////./pipe/docker_engine";
        else for(const candidate of [process.env.XDG_RUNTIME_DIR&&path.join(process.env.XDG_RUNTIME_DIR,"docker.sock"),process.platform==="darwin"&&path.join(home,".docker/run/docker.sock")].filter(Boolean)){try{if(fs.statSync(candidate).isSocket()){host="unix://"+candidate;break;}}catch{}}
        env.DOCKER_HOST=host;if(/^docker(?:\.exe)?$/i.test(path.basename(bin)))args=["--host",host,...args];
      }
      const child=exec(bin,args,{cwd:opts.cwd,timeout:opts.timeout??20000,maxBuffer:2*1024*1024,windowsHide:true,shell:false,encoding:"buffer",env},(error,stdout,stderr)=>{
        children.delete(child);cleanupChildren.delete(child);resolve({ok:!error,stdout:String(stdout||""),stderr:String(stderr||""),stdoutRaw:Buffer.isBuffer(stdout)?stdout:Buffer.from(stdout||""),stderrRaw:Buffer.isBuffer(stderr)?stderr:Buffer.from(stderr||""),error:error?redact(error.message.split("\n")[0]):null});
      });children.add(child);if(cleanup)cleanupChildren.add(child); if(closing&&!cleanup)child.kill();
    });
  }
  const manager=new NodeManager({templateRoot,dataRoot,intentPath,autoRecover:false});manager._exec=run;
  let intentDigest=hash(readFile(intentPath));
  manager._persistIntent=()=>{if(!cleanup)assertActive();safePath(intentPath,true);if(hash(readFile(intentPath))!==intentDigest)throw Error("Node supervisor settings changed outside Core; restart before managing it");fs.mkdirSync(path.dirname(intentPath),{recursive:true,mode:0o700});const bytes=Buffer.from(JSON.stringify(manager._intent)),temp=intentPath+"."+crypto.randomBytes(8).toString("hex")+".tmp";try{fs.writeFileSync(temp,bytes,{flag:"wx",mode:0o600});fs.renameSync(temp,intentPath);intentDigest=hash(bytes);}finally{fs.rmSync(temp,{force:true});}};
  manager.start=async(network,address)=>{
    if(closing)throw Error("Node action was cancelled");assertActive();if(manager._op?.running)throw Error("Wait for the current node operation to finish");
    await manager._assertControl(network);if(closing)throw Error("Node action was cancelled");assertActive();assertFiles(network,true);const currentServices=await manager.services(network);if(closing)throw Error("Node action was cancelled");assertActive();if(currentServices.some(s=>/running|restarting|up/i.test(s.state)))throw Error("This node is already running; stop it explicitly first");assertFiles(network);assertRestoreReady(manager.dirs(network).basedir);
    // No await between this lifetime check and configuration writes. Closing
    // while Docker ownership is checked cannot resurrect a saved start intent.
    let memorySaver=false;try{memorySaver=/^  jobs: 2\s*$/m.test(fs.readFileSync(path.join(manager.dirs(network).config,"config.yml"),"utf8"));}catch{}
    onStartIntent(network);manager.ensureFiles(network,address,{memorySaver});manager._saveIntent(network,true,address,memorySaver);manager._desiredRunning=true;
    manager._commandPending=manager._composeOp(network,"start",["up","-d","--remove-orphans"]);await manager._commandPending;return {started:true};
  };
  // Opening or inspecting an existing stack must never adopt its start intent.
  manager.ownership=network=>inspectOwner(run, NETWORKS[network].composeProject, manager.dirs(network).root); manager._adoptRunning=async()=>{}; manager._startWatchdog=()=>{}; manager._desiredRunning=false;
  const originalCompose=manager._compose.bind(manager);
  manager._compose=(network,args,opts)=>{assertFiles(network,true);return originalCompose(network,args,opts);};
  manager._composeOp=async(network,name,args)=>{
    if(closing&&name!=="stop")throw Error("Node action was cancelled");assertFiles(network,true);const op={name,network,running:true,startedAt:Date.now(),lines:[],code:null,error:null};manager._op=op;
    try{await manager._assertControl(network);if(closing&&name!=="stop")throw Error("Node action was cancelled"); const cmd=await manager.composeCmd();if(closing&&name!=="stop")throw Error("Node action was cancelled");if(!cmd)throw Error("Docker Compose is unavailable");if(closing&&name!=="stop")throw Error("Node action was cancelled");if(!cleanup)assertActive();const r=await run(cmd.bin,[...cmd.pre,"-p",NETWORKS[network].composeProject,"-f",path.join(manager.dirs(network).root,"docker-compose.yml"),...args],{cwd:manager.dirs(network).root,timeout:180000});op.lines=redact(r.stdout+"\n"+r.stderr).split(/\r?\n/).slice(-100);op.code=r.ok?0:1;op.error=r.ok?null:r.error||"Docker command failed";return op;}
    catch(e){op.code=1;op.error=redact(e.message);return op;}finally{op.running=false;op.finishedAt=Date.now();}
  };
  const scopedState={get:(...args)=>state.get(...args),set:(...args)=>{if(closing)throw Error("Node setup was cancelled");assertActive();return state.set(...args);}};
  const setup=new SetupService({downloadDir:path.join(path.dirname(intentPath),"downloads"),state:scopedState});setup._exec=run;
  const dockerApp=setup._dockerApp.bind(setup);setup._dockerApp=async()=>{const target=await dockerApp();if(closing)throw Error("Node setup was cancelled");assertActive();return target;};
  return {manager,setup,cancel(){if(closing)return;closing=true;for(const child of children)if(!cleanupChildren.has(child))child.kill();},async stop(network){cleanup=true;try{if(manager._commandPending)await manager._commandPending.catch(()=>{});const result=await manager.stop(network);if(manager._commandPending)await manager._commandPending;const op=manager.currentOp();if(op?.name==="stop"&&op.code!==0)throw Error(redact(op.error||"Docker did not stop the node. Use Docker Desktop to stop it manually"));return result;}finally{cleanup=false;}},dispose(){closing=true;for(const child of children)child.kill();setup.stopWatchers();manager.dispose();}};
}
function create(ctx, dependencies={}) {
  const root=path.join(fs.realpathSync(ctx.dataDir),"koinos-node");safePath(root);const settings=new GuardedStore(path.join(root,"settings.json"));
  let selected=settings.get("network","mainnet");if(!Object.hasOwn(NETWORKS,selected))throw Error("Saved node network is unrecognized; original settings were preserved");
  const savedPath=settings.get("node.dataDir",null);if(savedPath!==null&&(typeof savedPath!=="string"||!path.isAbsolute(savedPath)||/[\r\n\0$]/.test(savedPath)))throw Error("Saved node directory needs recovery");
  const dataRoot=savedPath||path.join(root,"node");if(/[\r\n\0$]/.test(dataRoot))throw Error("Node folder contains unsupported Compose interpolation characters; its data was preserved");safePath(dataRoot);
  const intentPath=path.join(root,"node-supervisor.json");const intentBytes=readFile(intentPath);if(intentBytes){try{if(!plain(JSON.parse(intentBytes)))throw Error();}catch{throw Error("Saved node supervisor state is unreadable; original preserved");}}
  let runtime=null,closed=false,busy=false,inspection=false,owned=null,snapshot=null,disposing=null,stopTask=null;
  const mode=()=>ctx.core.gateway.network.status().privacyMode;
  function active(signal){signal?.throwIfAborted();if(closed)throw Error("Koinos Node is closed");settings.assert();safePath(root);safePath(dataRoot);}
  function online(signal){active(signal);if(mode()==="local-only")throw Error("Local-Only blocks running or installing a network node");}
  function files(network,trust=false){
    safePath(dataRoot);const base=path.join(dataRoot,network);for(const folder of [base,path.join(base,"config"),path.join(base,"basedir"),path.join(base,"basedir/block_producer"),path.join(base,"basedir/chain"),path.join(base,"basedir/jsonrpc"),path.join(base,"basedir/jsonrpc/descriptors")])safePath(folder);
    const names=["docker-compose.yml",".env","config/config.yml","config/rabbitmq.conf","config/koinos_descriptors.pb","config/genesis_data.json","basedir/config.yml","basedir/chain/genesis_data.json","basedir/jsonrpc/descriptors/koinos_descriptors.pb","basedir/block_producer/public.key"];
    for(const name of names)safePath(path.join(base,name),true);
    safePath(intentPath,true);safePath(intentPath+"."+process.pid+".tmp",true);
    if(trust){const compose=readFile(path.join(base,"docker-compose.yml"));if(compose){const source=fs.readFileSync(path.join(templateRoot,"docker-compose.yml"),"utf8"),expected=process.platform==="darwin"?composeForMacos(source):source;if(compose.toString()!==expected)throw Error("Node Compose configuration was customized. Use the original app to manage it; Core preserved it");
      const env=readFile(path.join(base,".env"));const allowed=[];for(const producing of [false,true])for(const memory of [false,true])allowed.push(buildEnv(NETWORKS[network],path.join(base,"basedir"),producing,memory));if(!env||!allowed.includes(env.toString()))throw Error("Node environment configuration was customized. Core preserved it; inspect it before management");}
    }
  }
  function producer(){const config=readFile(path.join(dataRoot,selected,"config/config.yml"));return config?.toString().match(/^  producer: ([1-9A-HJ-NP-Za-km-z]{25,35})(?:\s|$)/m)?.[1]||null;}
  function getRuntime(){if(!runtime){const state=new GuardedStore(path.join(root,"state.json"));runtime=(dependencies.runtime||nativeRuntime)({dataRoot,intentPath,state,assertActive:()=>active(),assertFiles:files,onStartIntent:network=>{active();owned=network;}});}return runtime;}
  function status(){active();files(selected);return {network:selected,networks:Object.entries(NETWORKS).map(([id,n])=>({id,label:n.label})),dataDir:path.join(dataRoot,selected),platform:process.platform,privacyMode:mode(),inspectionAllowed:inspection,checkedAt:snapshot?.checkedAt||null,docker:snapshot?.docker||null,services:snapshot?.services||[],health:snapshot?.health||null,isRunning:snapshot?.isRunning||false,setup:snapshot?.setup||null,savedProducer:producer(),owned:owned===selected,op:runtime?.manager.currentOp?.()||null};}
  async function review(title,detail,signal){const ok=await ctx.confirm(title,detail);active(signal);return ok;}
  async function inspect(signal){const rt=getRuntime();files(selected,true);const result=await rt.manager.status(selected);active(signal);const setup=await rt.setup.status();active(signal);snapshot={docker:{ok:result.docker?.ok===true,error:redact(result.docker?.error),serverVersion:redact(result.docker?.serverVersion)},services:(result.services||[]).slice(0,30).map(s=>({service:redact(s.service),state:redact(s.state),status:redact(s.status)})),isRunning:result.isRunning===true,health:result.health?{ok:result.health.ok===true,message:redact(result.health.message||result.health.reason)}:null,setup:{platform:setup.platform,ready:setup.ready===true,wsl:setup.wsl?{installed:setup.wsl.installed===true,rebootPending:setup.wsl.rebootPending===true}:null,docker:setup.docker?{installed:setup.docker.installed===true,running:setup.docker.running===true}:null},checkedAt:Date.now()};return status();}
  function backupConfig(){const base=path.join(dataRoot,selected),originals={};for(const rel of ["docker-compose.yml",".env","config/config.yml","config/rabbitmq.conf","config/koinos_descriptors.pb","config/genesis_data.json"]){const bytes=readFile(path.join(base,rel));if(bytes)originals[rel]=bytes;}if(!Object.keys(originals).length)return;const dest=path.join(root,"core-config-backups",Date.now()+"-"+crypto.randomBytes(6).toString("hex"));safePath(dest);fs.mkdirSync(dest,{recursive:true,mode:0o700});for(const [rel,bytes]of Object.entries(originals)){const file=path.join(dest,rel);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,bytes,{flag:"wx",mode:0o600});if(!fs.readFileSync(file).equals(bytes))throw Error("Node configuration backup failed");}}
  function stopNode(network){if(stopTask)return stopTask;const currentRuntime=runtime;const task=(async()=>{await currentRuntime.stop(network);if(owned===network)owned=null;})().finally(()=>{if(stopTask===task)stopTask=null;});stopTask=task;return task;}
  function stopOwned(){if(stopTask)return stopTask;return owned?stopNode(owned):Promise.resolve();}
  return {
    async call(method,value={},signal){if(!Object.hasOwn(permissions,method))throw Error("Unknown node operation");active(signal);
      if(method==="node.status"){input(value,[]);return status();}
      if(busy)throw Error("Wait for the current node action to finish");busy=true;
      try{
        if(method==="node.inspect") {input(value,[]);if(!inspection){if(!await review("Inspect this Koinos node?","Allow Docker and platform prerequisite status commands while this plugin is open? These commands inspect this node and its logs without starting it. No wallet keys are read.",signal))return {cancelled:true};inspection=true;}return await inspect(signal);}
        if(method==="node.logs"){const v=input(value,["service","tail"]);if(!inspection)throw Error("Check this node first to approve local Docker inspection");if(v.service!==undefined&&v.service!==""&&!services.has(v.service))throw Error("Choose a known node service");const tail=v.tail===undefined?120:v.tail;if(!Number.isSafeInteger(tail)||tail<1||tail>300)throw Error("Choose between 1 and 300 log lines");files(selected,true);const text=await getRuntime().manager.logs(selected,v.service||undefined,tail);active(signal);return {text:redact(text)};}
        if(method==="node.configure"){const v=input(value,["network"]);if(!Object.hasOwn(NETWORKS,v.network))throw Error("Choose Mainnet or Harbinger");if(owned||runtime?.manager._op?.running||snapshot?.isRunning)throw Error("Stop the selected node before changing networks");if(!await review("Change node network?",`Select ${NETWORKS[v.network].label}? Existing databases stay in their current folders. This does not start a node.`,signal))return {cancelled:true};settings.set("network",v.network);selected=v.network;snapshot=null;return status();}
        if(method==="node.start"){const v=input(value,["mode"]);if(!["sync","resume"].includes(v.mode))throw Error("Choose sync or resume mode");online(signal);const address=v.mode==="resume"?producer():null;if(v.mode==="resume"&&!address)throw Error("No saved producer address exists for this network");if(owned)throw Error("This plugin already started a node");const context=hash(readFile(path.join(dataRoot,selected,"config/config.yml")));
          if(!await review("Start Koinos node?",`${NETWORKS[selected].label}\nFolder: ${path.join(dataRoot,selected)}\n${address?"Resume saved block producer: "+address:"Sync only; block production is disabled"}\n\nDocker may download Koinos images and use substantial storage, CPU and network bandwidth. Managed configuration is backed up then regenerated. Chain databases and producer keys stay in place. The node stops when this plugin closes or Local-Only is selected. No wallet transactions are authorized.`,signal))return {cancelled:true};online(signal);if(context!==hash(readFile(path.join(dataRoot,selected,"config/config.yml"))))throw Error("Node configuration changed during review; try again");files(selected,true);const rt=getRuntime();const current=await rt.manager.status(selected);online(signal);if(current.isRunning)throw Error("This node is already running. Stop it explicitly before starting it from this plugin");if(!current.docker?.ok)throw Error(current.docker?.error||"Install and start Docker first");if(current.control?.ok!==true)throw Error(redact(current.control?.message||"Cannot verify this node ownership; no changes were made"));backupConfig();files(selected);
          try{await rt.manager.start(selected,address);if(rt.manager._commandPending)await rt.manager._commandPending;online(signal);const op=rt.manager.currentOp();if(op?.code!==0)throw Error(redact(op?.error||"Node failed to start"));inspection=true;return await inspect(signal);}catch(e){await stopOwned().catch(()=>{});throw e;}}
        if(method==="node.stop"){input(value,[]);files(selected,true);if(!await review("Stop Koinos node?",`Stop only ${NETWORKS[selected].label} in ${path.join(dataRoot,selected)}? Block production pauses. Chain data, configuration and keys are retained.`,signal))return {cancelled:true};getRuntime();await stopNode(selected);active(signal);snapshot=null;return {stopped:true};}
        if(method==="node.setup"){const v=input(value,["action"]);if(!["dockerDocs","installWsl","startDocker"].includes(v.action))throw Error("Choose a supported setup action");online(signal);
          const descriptions={dockerDocs:"Open the official Docker installation guide in your browser? Download and install Docker there, then return to Check node. The plugin does not download or run installers automatically.",installWsl:"Install Windows Subsystem for Linux using the Windows system installer? Windows will ask for administrator permission. You may need to restart Windows manually afterward.",startDocker:"Open your installed Docker Desktop application? It may start other containers configured by you. No installer will run if Docker is missing."};if(v.action==="installWsl"&&process.platform!=="win32")throw Error("WSL setup is available only on Windows");if(v.action==="startDocker"&&process.platform==="linux")throw Error("Use your distribution's service manager to start Docker Engine");if(!await review("Set up Docker",descriptions[v.action],signal))return {cancelled:true};online(signal);if(v.action==="dockerDocs"){await ctx.electron.shell.openExternal(DOCKER_DOCS[process.platform]||DOCKER_DOCS.linux);return {opened:true};}const rt=getRuntime();const result=v.action==="installWsl"?await rt.setup.installWsl():await rt.setup.startDocker({installIfMissing:false});active(signal);return result;}
      }finally{busy=false;}
    },
    async privacyChanged(next){if(next!=="local-only")return;runtime?.cancel();await stopOwned();runtime?.dispose();runtime=null;inspection=false;snapshot=null;},
    async dispose(){if(disposing)return disposing;closed=true;runtime?.cancel();disposing=(async()=>{try{await stopOwned();}finally{runtime?.dispose();runtime=null;}})();return disposing;},
  };
}
module.exports={pluginId,permissions,create,GuardedStore,redact,nativeRuntime};
