"use strict";
// An explicit one-way copy of model artifacts. Alpha's settings, credentials,
// plugin files, runtime binaries and generated Ollama cache are never imported.
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const MAX_MODELS = 4096, MAX_STATE_BYTES = 4 * 1024 * 1024, CHUNK = 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/i;
const regular = st => st.isFile() && !st.isSymbolicLink() && st.nlink === 1;
const identity = st => ({dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs});
const same = (a,b) => a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs && a.ctimeMs===b.ctimeMs;
const absent = error => error?.code === "ENOENT";
const pretty = file => path.basename(file);
const pathKey = file => process.platform === "win32" ? file.toLowerCase() : file;
const inodeKey = st => `${st.dev}:${st.ino}`;
const sameContentIdentity = (a,b) => a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs;
function inside(directory,file) { const relative=path.relative(pathKey(directory),pathKey(file));return !!relative && relative!==".." && !relative.startsWith(".."+path.sep) && !path.isAbsolute(relative); }
function throwAborted(signal) { if(signal?.aborted)throw Object.assign(new Error("Model migration cancelled"),{name:"AbortError",cause:signal.reason}); }
function noLinkedParents(file) {
  const absolute=path.resolve(file), parsed=path.parse(absolute);let cursor=parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,component);const st=fs.lstatSync(cursor);
    // macOS provides these system aliases for the real temporary directory.
    const systemAlias=process.platform==="darwin" && ["/var","/tmp","/etc"].includes(cursor);
    if (st.isSymbolicLink() && !systemAlias) throw Error(`Linked model path is not supported: ${pretty(file)}`);
  }
  return fs.realpathSync(absolute);
}
function rootDirectory(directory) {
  const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())throw Error("Expected a real model profile directory");
  return noLinkedParents(directory);
}
function pairedFile(file,st,pair) {
  if(!pair||!st.isFile()||st.isSymbolicLink()||st.nlink!==2||pathKey(file)===pathKey(pair.target))return false;
  const target=noLinkedParents(pair.target),other=fs.lstatSync(target);
  return other.isFile()&&!other.isSymbolicLink()&&other.nlink===2&&same(identity(st),identity(other));
}
function sourceFile(file,pair=null) {
  const resolved=noLinkedParents(file), st=fs.lstatSync(resolved);
  const linked=pairedFile(resolved,st,pair);
  if((!regular(st)&&!linked)||!Number.isSafeInteger(st.size)||st.size<4)throw Error(`Unsafe or empty model file: ${pretty(file)}`);
  const fd=fs.openSync(resolved,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try {const opened=fs.fstatSync(fd);if((!regular(opened)&&!pairedFile(resolved,opened,pair))||!same(identity(st),identity(opened)))throw Error("Model changed while opening");const magic=Buffer.alloc(4);if(fs.readSync(fd,magic,0,4,0)!==4||magic.toString("ascii")!=="GGUF")throw Error(`Not a GGUF model: ${pretty(file)}`);} finally {fs.closeSync(fd);}
  return {source:resolved,snapshot:identity(st),sizeBytes:st.size,...(linked?{pairedTarget:pair.target,pairSha256:pair.sha256}:{})};
}
function checkedState(file) {
  let st;try{st=fs.lstatSync(file);}catch(error){if(absent(error))return {};throw error;}
  noLinkedParents(file);if(!regular(st)||st.size>MAX_STATE_BYTES)throw Error("Alpha model metadata is unsafe or too large");
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{const opened=fs.fstatSync(fd);if(!same(identity(st),identity(opened)))throw Error("Alpha model metadata changed");const bytes=Buffer.alloc(opened.size);let offset=0;while(offset<bytes.length){const read=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!read)throw Error("Alpha model metadata became shorter");offset+=read;}if(!same(identity(opened),identity(fs.fstatSync(fd)))||!same(identity(opened),identity(fs.lstatSync(file))))throw Error("Alpha model metadata changed");const data=JSON.parse(bytes.toString("utf8"));if(!data||Array.isArray(data)||typeof data!=="object")throw Error("Alpha model metadata is invalid");return data;}finally{fs.closeSync(fd);}
}
function catalogFiles(catalog) {
  const names=new Map(),hashes=new Map();
  for(const [id,pkg] of Object.entries(catalog?.packages||{})){
    for(const [kind,p] of [["weight",pkg],["projector",pkg.mmproj]]){
      if(!p)continue;
      if(typeof p.filename!=="string"||path.basename(p.filename)!==p.filename||!p.filename.toLowerCase().endsWith(".gguf")||/[\\/:\x00-\x1f]/.test(p.filename))throw Error("Invalid Core model catalog filename");
      const artifact={kind,packageId:id,filename:p.filename,sha256:SHA.test(p.sha256||"")?p.sha256.toLowerCase():null,sizeBytes:p.sizeBytes};
      names.set(p.filename.toLowerCase(),artifact);if(artifact.sha256)hashes.set(artifact.sha256,artifact);
    }
  }
  return {names,hashes};
}
function pendingMovePairs(destinationDir,catalog) {
  const pairs=new Map();if(!destinationDir)return pairs;
  let directory;try{directory=rootDirectory(destinationDir);}catch(error){if(absent(error))return pairs;throw Error(`Unsafe model destination: ${error.message}`);}
  const {names}=catalogFiles(catalog),reader=fs.opendirSync(directory);let count=0;
  try{let entry;while((entry=reader.readSync())){
    if(++count>MAX_MODELS)throw Error("Core model folder contains too many entries");
    const known=names.get(entry.name.toLowerCase()),match=/^alpha-([a-f0-9]{64})\.gguf$/.exec(entry.name);
    const hash=known?.sha256||match?.[1];if(!hash)continue;
    const target=path.join(directory,entry.name),st=fs.lstatSync(target);
    if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===2)pairs.set(inodeKey(st),{target,sha256:hash});
  }}finally{reader.closeSync();}
  return pairs;
}
function inspectAlphaModels({sourceDir,catalog,destinationDir}={}) {
  const root=rootDirectory(sourceDir),{names}=catalogFiles(catalog),pairs=pendingMovePairs(destinationDir,catalog),items=[],warnings=[],seen=new Map();
  function add(file,metadata={}){
    try{
      if(typeof file!=="string"||!path.isAbsolute(file)||!file.toLowerCase().endsWith(".gguf"))throw Error("Imported model has an invalid GGUF path");
      if(items.length>=MAX_MODELS)throw Error("Alpha contains too many model files");
      const pair=inside(path.join(root,"models"),file)?pairs.get(inodeKey(fs.lstatSync(file))):null;
      const candidate=sourceFile(file,pair),key=process.platform==="win32"?candidate.source.toLowerCase():candidate.source;
      const known=names.get(path.basename(file).toLowerCase());
      if(!known && /(?:mmproj|projector)/i.test(path.basename(file))){warnings.push(`Unsupported vision projector ${pretty(file)} was not included. Image support may need the current catalog projector.`);return;}
      if(metadata.sha256!==undefined&&!SHA.test(metadata.sha256))throw Error(`Invalid saved hash for ${pretty(file)}`);
      if(seen.has(key)){const prior=seen.get(key);if(metadata.sha256){if(prior.expectedSha&&prior.expectedSha!==metadata.sha256.toLowerCase())throw Error(`Conflicting model hashes for ${pretty(file)}`);prior.expectedSha=metadata.sha256.toLowerCase();}if(typeof metadata.label==="string")prior.label=metadata.label;if(typeof metadata.alias==="string")prior.alias=metadata.alias;if(metadata.contextSize!==undefined)prior.contextSize=metadata.contextSize;return;}
      const item={...candidate,label:typeof metadata.label==="string"?metadata.label:path.basename(file,".gguf"),alias:metadata.alias,contextSize:metadata.contextSize,expectedSha:known?.sha256||metadata.sha256?.toLowerCase()||candidate.pairSha256||null,known:known||null,cleanupEligible:inside(path.join(root,"models"),candidate.source)};
      if(known&&!known.sha256)throw Error(`Core has no trusted hash for ${pretty(file)}; download or import it explicitly.`);
      seen.set(key,item);items.push(item);
    }catch(error){warnings.push(error.message);}
  }
  const directory=path.join(root,"models");
  try{
    const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())throw Error("Alpha models folder is linked or is not a directory");
    const reader=fs.opendirSync(directory);let count=0;
    try{let entry;while((entry=reader.readSync())){if(++count>MAX_MODELS)throw Error("Alpha models folder contains too many entries");if(entry.name.toLowerCase().endsWith(".gguf"))add(path.join(directory,entry.name));}}finally{reader.closeSync();}
  }catch(error){if(!absent(error))warnings.push(error.message);}
  try{
    const state=checkedState(path.join(root,"state.json"));
    if(state.customModels!==undefined&&(!Array.isArray(state.customModels)||state.customModels.length>MAX_MODELS))throw Error("Alpha imported model metadata is invalid");
    for(const entry of state.customModels||[]) {
      if(!entry||typeof entry!=="object"||Array.isArray(entry)){warnings.push("An invalid imported model entry was skipped.");continue;}
      add(entry.path,{label:entry.label,alias:entry.alias,contextSize:entry.contextSize,sha256:entry.sha256});
    }
  }catch(error){warnings.push(error.message);}
  for (const item of items) {
    const projector = item.known?.kind === "weight" && catalog.packages[item.known.packageId]?.mmproj;
    if (projector && !items.some(candidate => candidate.known?.filename === projector.filename)) {
      warnings.push(`${pretty(item.source)} needs its current vision projector for image support; the projector was not found in Alpha.`);
    }
  }
  return {count:items.filter(item=>item.known?.kind!=="projector").length,bytes:items.reduce((sum,item)=>sum+item.sizeBytes,0),cleanupEligibleCount:items.filter(item=>item.cleanupEligible).length,cleanupExternalCount:items.filter(item=>!item.cleanupEligible).length,items,warnings};
}
function ensureChild(root,relative) {
  const parts=relative.split(path.sep).filter(Boolean);let cursor=root;
  for(const part of parts){if(part===".."||part===".")throw Error("Invalid model destination");cursor=path.join(cursor,part);try{fs.mkdirSync(cursor,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;}const st=fs.lstatSync(cursor);if(!st.isDirectory()||st.isSymbolicLink()||pathKey(fs.realpathSync(cursor))!==pathKey(cursor))throw Error("Unsafe model destination directory");}
  return cursor;
}
async function digestFile(file,signal,pair=null) {
  const safe=noLinkedParents(file),before=fs.lstatSync(safe);if(!regular(before)&&!pairedFile(safe,before,pair))throw Error("Existing Core model is not a regular private file");
  const handle=await fsp.open(safe,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)),hash=crypto.createHash("sha256"),buffer=Buffer.allocUnsafe(CHUNK);
  try{const opened=await handle.stat();if(!same(identity(before),identity(opened)))throw Error("Model changed while opening");let position=0;while(position<before.size){throwAborted(signal);const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!bytesRead)throw Error("Model became shorter during verification");hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}const after=await handle.stat();if(!same(identity(opened),identity(after))||!same(identity(after),identity(fs.lstatSync(safe)))||(!regular(after)&&!pairedFile(safe,after,pair)))throw Error("Model changed during verification");return {sha256:hash.digest("hex"),bytes:position,snapshot:identity(after)};}finally{await handle.close();}
}
async function copyToStage(item,directory,signal,onChunk) {
  const source=sourceFile(item.source);if(!same(item.snapshot,source.snapshot))throw Error(`Alpha model changed; reopen migration: ${pretty(item.source)}`);
  const temporary=path.join(directory,`.alpha-model-${crypto.randomUUID()}.tmp`),input=await fsp.open(item.source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let output,created=false;
  try{
    const opened=await input.stat();if(!regular(opened)||!same(item.snapshot,identity(opened)))throw Error("Alpha model changed while opening");
    output=await fsp.open(temporary,"wx",0o600);created=true;
    const hash=crypto.createHash("sha256"),buffer=Buffer.allocUnsafe(CHUNK);let position=0;
    while(position<item.sizeBytes){throwAborted(signal);const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,item.sizeBytes-position),position);if(!bytesRead)throw Error("Alpha model became shorter during migration");hash.update(buffer.subarray(0,bytesRead));let offset=0;while(offset<bytesRead){throwAborted(signal);const written=await output.write(buffer,offset,bytesRead-offset,position+offset);if(!written.bytesWritten)throw Error("Model copy stopped");offset+=written.bytesWritten;}position+=bytesRead;onChunk(bytesRead);}
    await output.sync();await output.close();output=null;
    const after=await input.stat();if(position!==item.sizeBytes||!same(item.snapshot,identity(after))||!same(item.snapshot,identity(fs.lstatSync(item.source))))throw Error(`Alpha model changed during migration: ${pretty(item.source)}`);
    const sha256=hash.digest("hex");if(item.expectedSha&&sha256!==item.expectedSha)throw Error(`Model integrity check failed: ${pretty(item.source)}`);
    const copied=await digestFile(temporary,signal);if(copied.sha256!==sha256||copied.bytes!==position)throw Error("Copied model did not pass verification");
    return {temporary,sha256,bytes:position};
  }catch(error){if(output)await output.close().catch(()=>{});if(created)await fsp.unlink(temporary).catch(()=>{});throw error;}finally{await input.close();}
}
async function publishCopy(staged,target,signal) {
  throwAborted(signal);
  try{
    // A hard link is used only between our verified staging file and its final
    // name, making publication atomic and refusing an existing destination.
    // Removing the staging name immediately leaves one ordinary owned file.
    fs.linkSync(staged.temporary,target);fs.unlinkSync(staged.temporary);return true;
  }catch(error){
    if(error.code!=="EEXIST")throw error;
    const existing=await digestFile(target,signal);if(existing.sha256!==staged.sha256||existing.bytes!==staged.bytes)throw Error(`Existing Core model differs and was preserved: ${pretty(target)}`);
    return false;
  }
}
function mergeCustom(models,staged,target,item) {
  // JsonStore intentionally falls back to defaults for malformed state files.
  // Migration must not turn that fallback into replacing existing user data.
  if(typeof models.state.filePath==="string"){
    try{
      const disk=checkedState(models.state.filePath),live=typeof models.state.all==="function"?models.state.all():models.state.data;
      if(!isDeepStrictEqual(disk,live))throw Error("The saved Core state changed since it was loaded");
    }catch{throw Error("Core state is unreadable or changed on disk; restart or repair it before migrating imported models. Existing state was preserved.");}
  }
  const before=models.state.get("customModels",[]);if(!Array.isArray(before)||before.some(c=>!c||typeof c!=="object"))throw Error("Core imported model metadata needs attention; it was preserved");
  const existing=before.find(c=>String(c.sha256).toLowerCase()===staged.sha256);
  if(existing) {
    // Preserve Core naming and metadata while pointing at the verified owned
    // copy. This also repairs missing references without touching old files.
    if(existing.path!==target||existing.sizeBytes!==staged.bytes){models.state.set("customModels",before.map(c=>String(c.sha256).toLowerCase()===staged.sha256?{...c,path:target,sha256:staged.sha256,sizeBytes:staged.bytes}:c));}
    return existing.alias;
  }
  const cleanLabel=String(item.label||"Alpha model").replace(/[\x00-\x1f\x7f]/g," ").trim().slice(0,60)||"Alpha model";
  let base=typeof item.alias==="string"&&/^custom-[a-z0-9-]{1,100}$/.test(item.alias)?item.alias:`custom-${cleanLabel.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,40)||"alpha-model"}`;
  let alias=base,index=2;while(before.some(c=>c.alias===alias)||Object.hasOwn(models.catalog.aliases||{},alias))alias=`${base}-${index++}`;
  const entry={alias,label:cleanLabel,path:target,sha256:staged.sha256,sizeBytes:staged.bytes,contextSize:Number.isSafeInteger(item.contextSize)&&item.contextSize>=512&&item.contextSize<=262144?item.contextSize:4096,minRamGb:Math.max(4,Math.ceil(staged.bytes/1e9*1.4+1)),importedAt:new Date().toISOString()};
  models.state.set("customModels",[...before,entry]);return alias;
}
function syncDirectory(directory) {
  let fd;
  try{fd=fs.openSync(directory,fs.constants.O_RDONLY);fs.fsyncSync(fd);}
  catch(error){
    // Windows does not expose directory FlushFileBuffers through Node. File
    // handles are still flushed before unlinking an original on that platform.
    if(process.platform!=="win32"||!["EPERM","EACCES","EISDIR","EINVAL","EBADF","ENOTSUP"].includes(error.code))throw error;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
function syncFile(file,expected,pair=null) {
  const safe=noLinkedParents(file),before=fs.lstatSync(safe);
  if(!same(expected,identity(before))||(!regular(before)&&!pairedFile(safe,before,pair)))throw Error("Core model changed before its original could be removed");
  // FlushFileBuffers on Windows needs a writable handle. This does not alter
  // the bytes; inability to open/flush preserves the Alpha original.
  const fd=fs.openSync(safe,fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0));
  try{if(!same(expected,identity(fs.fstatSync(fd))))throw Error("Core model changed while opening");fs.fsyncSync(fd);if(!same(expected,identity(fs.fstatSync(fd)))||!same(expected,identity(fs.lstatSync(safe))))throw Error("Core model changed during flushing");}finally{fs.closeSync(fd);}
}
function syncRegistration(models,known) {
  if(!known){
    if(typeof models.state.filePath!=="string")throw Error("Core model registration cannot be flushed; the Alpha original was kept");
    const disk=checkedState(models.state.filePath),live=typeof models.state.all==="function"?models.state.all():models.state.data;
    if(!isDeepStrictEqual(disk,live))throw Error("Core model registration changed before cleanup; the Alpha original was kept");
    const before=fs.lstatSync(models.state.filePath);syncFile(models.state.filePath,identity(before));syncDirectory(path.dirname(models.state.filePath));
  }
}
function cleanupOriginal(item,target,targetSnapshot,models,known,signal) {
  throwAborted(signal);
  const targetPair=item.pairedTarget?{target:item.source}:null;
  syncFile(target,targetSnapshot,targetPair);syncRegistration(models,known);syncDirectory(path.dirname(target));
  throwAborted(signal);
  // No await between these final identity proofs and unlink. A changed source
  // or destination always leaves the original in place.
  const source=sourceFile(item.source,item.pairedTarget?{target:item.pairedTarget}:null);
  if(!same(item.snapshot,source.snapshot)||!same(targetSnapshot,identity(fs.lstatSync(target))))throw Error("A model changed before cleanup; its Alpha original was kept");
  const sourceLinks=fs.lstatSync(item.source).nlink;
  fs.unlinkSync(item.source);
  let warning;try{syncDirectory(path.dirname(item.source));}catch{warning=`The old ${pretty(item.source)} was removed, but its folder could not be flushed. The verified Core model is safe.`;}
  return {bytes:item.sizeBytes,reclaimedBytes:sourceLinks===1?item.sizeBytes:0,warning};
}
async function recoverPublishedStage(target,sha256,sizeBytes,signal) {
  const targetStat=fs.lstatSync(target);if(!targetStat.isFile()||targetStat.isSymbolicLink()||targetStat.nlink!==2)return;
  const directory=path.dirname(target),reader=fs.opendirSync(directory);let count=0,temporary;
  try{let entry;while((entry=reader.readSync())){
    if(++count>MAX_MODELS)throw Error("Core model folder contains too many entries");
    if(!/^\.alpha-model-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(entry.name))continue;
    const file=path.join(directory,entry.name),st=fs.lstatSync(file);
    if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===2&&same(identity(st),identity(targetStat))){temporary=file;break;}
  }}finally{reader.closeSync();}
  if(!temporary)return;
  // A process can stop between publishing a verified staging inode and
  // removing its temporary name. Recover only this exact owned two-link pair.
  const proof=await digestFile(target,signal,{target:temporary});
  if(proof.sha256!==sha256||proof.bytes!==sizeBytes)throw Error("An interrupted Core model copy failed verification; its files were kept");
  syncFile(target,proof.snapshot,{target:temporary});syncDirectory(directory);throwAborted(signal);
  if(!same(proof.snapshot,identity(fs.lstatSync(target)))||!pairedFile(target,fs.lstatSync(target),{target:temporary}))throw Error("An interrupted Core model copy changed; its files were kept");
  fs.unlinkSync(temporary);syncDirectory(directory);
}
async function migrateAlphaModels({sourceDir,models,signal,onProgress=()=>{},deleteOldModels=false}={}) {
  if(typeof deleteOldModels!=="boolean")throw Error("Choose whether to delete old model files");
  if(!models?.catalog||!models?.state||typeof models.modelsDir!=="string")throw Error("Core model service is unavailable");
  if(models._active||models._importing||models._alphaMigration||models._removing?.size)throw Error("Wait for the current model download, import or removal before migrating");
  const source=rootDirectory(sourceDir),profile=rootDirectory(path.dirname(models.modelsDir));
  const sourceKey=pathKey(source),profileKey=pathKey(profile);
  if(sourceKey===profileKey||sourceKey.startsWith(profileKey+path.sep)||profileKey.startsWith(sourceKey+path.sep))throw Error("Alpha and Core model profiles must be separate");
  const inventory=inspectAlphaModels({sourceDir:source,catalog:models.catalog,destinationDir:models.modelsDir}),{hashes}=catalogFiles(models.catalog),result={copied:0,skipped:0,models:0,bytes:0,failed:0,moved:0,deleted:0,cleanupFailed:0,cleanupSkipped:0,sourceBytesRemoved:0,reclaimedBytes:0,warnings:[...inventory.warnings]};
  const controller=new AbortController(),joined=signal?AbortSignal.any([signal,controller.signal]):controller.signal,active={alias:"Alpha model migration",controller},importing={path:"Koinos AI Alpha models",pct:0};
  models._alphaMigration=active;models._active=active;models._importing=importing;let completedBytes=0;const completedModels=new Set();
  const progress=detail=>{importing.pct=inventory.bytes?Math.min(100,Math.floor(completedBytes/inventory.bytes*100)):100;try{onProgress({completedBytes,totalBytes:inventory.bytes,detail,copied:result.copied,skipped:result.skipped});}catch{/* A closed progress view must not interrupt a safe copy. */}};
  const assertSource=item=>{if(!same(item.snapshot,sourceFile(item.source,item.pairedTarget?{target:item.pairedTarget}:null).snapshot))throw Error(`Alpha model changed; reopen migration: ${pretty(item.source)}`);};
  const assertAllowed=(item,sha256,known)=>{
    const quarantine=models.state.get("quarantined",{});
    if(quarantine[known?.packageId]||quarantine[`custom:${sha256}`])throw Error(`Core has quarantined ${pretty(item.source)}; it was not migrated.`);
  };
  try{
    if(!inventory.count)throw Error("No supported Alpha model files remain; reopen migration to check the source.");
    throwAborted(joined);const destination=ensureChild(profile,path.basename(path.resolve(models.modelsDir)));
    for(const original of inventory.items){
      let item={...original};throwAborted(joined);let staged,target,created=false,createdIdentity,fastMove=false,committed=false;const start=completedBytes;
      try{
        assertSource(item);progress(`Checking ${pretty(item.source)}`);
        let verified=null,sha256=item.expectedSha;
        const sourcePair=item.pairedTarget?{target:item.pairedTarget}:null;
        if(!sha256){verified=await digestFile(item.source,joined,sourcePair);sha256=verified.sha256;assertSource(item);}
        const known=hashes.get(sha256);
        if(item.known&&known?.filename!==item.known.filename)throw Error(`Model catalog verification failed: ${pretty(item.source)}`);
        if(known&&Number.isSafeInteger(known.sizeBytes)&&known.sizeBytes!==item.sizeBytes)throw Error(`Model size does not match the Core catalog: ${pretty(item.source)}`);
        assertAllowed(item,sha256,known);
        // Keep copied imports inside the existing, accounted-for model store.
        target=path.join(destination,known?known.filename:`alpha-${sha256}.gguf`);
        if(item.pairedTarget&&pathKey(item.pairedTarget)!==pathKey(target))throw Error("An interrupted model move does not match its verified Core destination");
        let exists;try{fs.lstatSync(target);exists=true;}catch(error){if(!absent(error))throw error;exists=false;}
        if(exists){
          if(!item.pairedTarget)await recoverPublishedStage(target,sha256,item.sizeBytes,joined);
          const existing=await digestFile(target,joined,item.pairedTarget?{target:item.source}:null);
          if(existing.sha256!==sha256||existing.bytes!==item.sizeBytes)throw Error(`Existing Core model differs and was preserved: ${pretty(target)}`);
          verified=verified||await digestFile(item.source,joined,sourcePair);assertSource(item);
          if(verified.sha256!==sha256||verified.bytes!==item.sizeBytes)throw Error(`Model integrity check failed: ${pretty(item.source)}`);
          staged={sha256,bytes:item.sizeBytes};
        }else{
          if(deleteOldModels&&item.cleanupEligible&&item.snapshot.dev===fs.statSync(destination).dev){
            verified=verified||await digestFile(item.source,joined);assertSource(item);throwAborted(joined);
            if(verified.sha256!==sha256||verified.bytes!==item.sizeBytes)throw Error(`Model integrity check failed: ${pretty(item.source)}`);
            try{
              // Same-volume publication uses no model-sized spare space. The
              // original remains present until metadata and file are durable.
              fs.linkSync(item.source,target);created=true;fastMove=true;createdIdentity=identity(fs.lstatSync(target));
              const linked=sourceFile(item.source,{target,sha256});
              if(!sameContentIdentity(item.snapshot,linked.snapshot))throw Error("Alpha model changed while preparing its move");
              item={...item,...linked};staged={sha256,bytes:item.sizeBytes};
            }catch(error){if(created||!["EXDEV","EOPNOTSUPP","ENOTSUP","EPERM"].includes(error.code))throw error;}
          }
          if(!created){
            const stat=fs.statfsSync(destination);
            if(Number(stat.bavail)*Number(stat.bsize)<item.sizeBytes)throw Error(`Not enough free space to copy ${pretty(item.source)}. One model at a time must fit before its old copy can be removed.`);
            progress(`Copying ${pretty(item.source)}`);
            staged=await copyToStage({...item,expectedSha:sha256},destination,joined,bytes=>{completedBytes+=bytes;progress(`Copying ${pretty(item.source)}`);});
            assertSource(item);assertAllowed(item,sha256,known);
            created=await publishCopy(staged,target,joined);
            if(created)createdIdentity=identity(fs.lstatSync(target));
          }
        }
        // Also verifies recovered two-link moves before registration or cleanup.
        const targetProof=deleteOldModels||item.pairedTarget?await digestFile(target,joined,item.pairedTarget?{target:item.source}:null):null;
        if(targetProof&&(targetProof.sha256!==sha256||targetProof.bytes!==item.sizeBytes))throw Error(`Core model verification failed: ${pretty(target)}`);
        if(deleteOldModels&&item.cleanupEligible)progress(`Finishing move of ${pretty(item.source)}`);
        assertSource(item);
        if(targetProof&&!same(targetProof.snapshot,identity(fs.lstatSync(target))))throw Error("Core model changed before registration");
        throwAborted(joined);assertAllowed(item,sha256,known);
        if(!known)mergeCustom(models,staged,target,item);
        committed=true;
        if(created){result.copied++;result.bytes+=staged.bytes;}else result.skipped++;
        if(known?.kind!=="projector")completedModels.add(sha256);
        result.models=completedModels.size;
        if(deleteOldModels){
          if(!item.cleanupEligible){result.cleanupSkipped++;result.warnings.push(`Kept imported original outside Alpha's models folder: ${item.source}`);}
          else{
            try{
              const removed=cleanupOriginal(item,target,targetProof.snapshot,models,known,joined);
              result.deleted++;result.sourceBytesRemoved+=removed.bytes;result.reclaimedBytes+=removed.reclaimedBytes;if(fastMove)result.moved++;
              if(removed.warning)result.warnings.push(removed.warning);
            }catch(error){if(joined.aborted)throw error;result.cleanupFailed++;result.warnings.push(`Core has ${pretty(target)}, but its old model was kept: ${error.message}`);}
          }
        }
      }catch(error){
        if(created&&target&&!committed){try{const targetStat=fs.lstatSync(target);if(!createdIdentity||!(fastMove?pairedFile(target,targetStat,{target:item.source})&&inodeKey(targetStat)===`${createdIdentity.dev}:${createdIdentity.ino}`:same(createdIdentity,identity(targetStat))))throw Error("Model was replaced");fs.unlinkSync(target);}catch{result.warnings.push(`The verified copy ${pretty(target)} remains on disk but was not registered.`);}}
        if(joined.aborted){error.partialResult=result;throw error;}
        result.failed++;result.warnings.push(error.message);
      }finally{
        if(staged?.temporary)await fsp.unlink(staged.temporary).catch(error=>{if(!absent(error))result.warnings.push(`Could not remove a temporary model copy: ${error.message}`);});
        completedBytes=Math.max(completedBytes,start+item.sizeBytes);
      }
    }
    progress("Model migration complete");return result;
  }catch(error){
    error.partialResult=result;throw error;
  }finally{
    if(models._alphaMigration===active)models._alphaMigration=null;
    if(models._active===active){models._active=null;models._progress=null;}if(models._importing===importing)models._importing=null;
  }
}
module.exports={inspectAlphaModels,migrateAlphaModels};
