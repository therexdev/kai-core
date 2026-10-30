"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {canonical,safeId,safeFile,MAX_BYTES,MAX_FILES,PERMISSIONS,BINARY}=require("./package");
const verifiedPackages=new WeakMap();
function list(value,name,accepts){if(!Array.isArray(value)||value.length>100||new Set(value).size!==value.length||value.some(item=>!accepts(item)))throw Error(`Invalid ${name}`);}
function verifyMetadata({manifest:m,entries,publicKey,signature}){
 if(!m||m.schema!==2||m.apiVersion!==3||!safeId(m.id)||typeof m.version!=="string"||!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(m.version)||typeof m.name!=="string"||!m.name.trim()||m.name.length>100)throw Error("Invalid or incompatible plugin manifest; Foundation requires schema 2 / API 3");
 if(Object.keys(m).some(key=>!["schema","apiVersion","id","version","name","description","entry","permissions","runtime","service","provides","consumes"].includes(key)))throw Error("Unknown manifest field");
 if(m.description!==undefined&&(typeof m.description!=="string"||m.description.length>1000))throw Error("Invalid description");
 if(!["sandboxed","native"].includes(m.runtime))throw Error("Unsupported plugin runtime");
 list(m.permissions,"plugin permissions",permission=>PERMISSIONS.includes(permission));list(m.provides??[],"provided services",safeId);list(m.consumes??[],"consumed services",safeId);
 if(m.runtime==="native"&&(!m.permissions.includes("native.execute")||!safeFile(m.service)||!/\.(?:c?js)$/.test(m.service)))throw Error("Native plugins require a service entry and explicit native.execute trust");
 if(m.runtime==="sandboxed"&&(m.service!==undefined||m.permissions.includes("native.execute")||(m.provides?.length||0)))throw Error("Sandboxed plugins cannot load native services");
 if(!Array.isArray(entries)||!entries.length||entries.length>MAX_FILES)throw Error("Invalid plugin files");
 const names=new Set(),lower=new Set(),table=[];
 for(const entry of entries){if(!entry||Object.keys(entry).sort().join()!=="bytes,encoding,path,sha256"||!safeFile(entry.path)||lower.has(entry.path.toLowerCase())||entry.encoding!==(BINARY.test(entry.path)?"base64":"utf8")||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(entry.sha256))throw Error("Invalid or duplicate plugin file metadata");names.add(entry.path);lower.add(entry.path.toLowerCase());table.push({...entry});}
 for(const name of lower){const parts=name.split("/");parts.pop();while(parts.length){if(lower.has(parts.join("/")))throw Error("Conflicting plugin file paths");parts.pop();}}
 if(!safeFile(m.entry)||!m.entry.endsWith(".html")||!names.has(m.entry))throw Error("Plugin UI entry is missing");if(m.runtime==="native"&&!names.has(m.service))throw Error("Plugin service entry is missing");
 if(typeof publicKey!=="string"||publicKey.length>200||typeof signature!=="string"||signature.length>200||Buffer.from(publicKey,"base64").toString("base64")!==publicKey||Buffer.from(signature,"base64").toString("base64")!==signature)throw Error("Invalid publisher signature");
 table.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);const payload=canonical({domain:"kai-plugin-package-v3",manifest:m,files:table});
 const key=crypto.createPublicKey({key:Buffer.from(publicKey,"base64"),format:"der",type:"spki"});if(key.asymmetricKeyType!=="ed25519"||!crypto.verify(null,Buffer.from(payload),key,Buffer.from(signature,"base64")))throw Error("Plugin signature verification failed");
 const fingerprint=crypto.createHash("sha256").update(key.export({format:"der",type:"spki"})).digest("hex"),digest=crypto.createHash("sha256").update("kai-plugin-package-digest-v3\0").update(payload).update("\0").update(publicKey).update("\0").update(signature).digest("hex");
 const manifest=Object.freeze(Object.fromEntries(Object.entries(m).map(([key,value])=>[key,Array.isArray(value)?Object.freeze([...value]):value])));
 return {manifest,fingerprint,digest,entries:Object.freeze(table.map(entry=>Object.freeze(entry)))};
}
function hashFile(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw Error("Expected a regular plugin file");const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)),hash=crypto.createHash("sha256"),buffer=Buffer.allocUnsafe(256*1024);try{const opened=fs.fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw Error("Plugin file changed while opening");let length,total=0;while((length=fs.readSync(fd,buffer,0,buffer.length,null))>0){total+=length;if(total>MAX_BYTES)throw Error("Plugin file exceeds its byte limit");hash.update(buffer.subarray(0,length));}return{sha256:hash.digest("hex"),bytes:total};}finally{fs.closeSync(fd);}}
function verifyCodeRoot(root,entries){const expected=new Map(entries.map(entry=>[entry.path,entry])),seen=new Set();function walk(directory,prefix=""){const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())throw Error("Unsafe plugin code directory");for(const name of fs.readdirSync(directory)){const relative=prefix?`${prefix}/${name}`:name,file=path.join(directory,name),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error("Plugin code contains a symbolic link");if(stat.isDirectory()){walk(file,relative);continue;}const entry=expected.get(relative);if(!entry)throw Error("Plugin code contains an unverified file");const actual=hashFile(file);if(actual.bytes!==entry.bytes||actual.sha256!==entry.sha256)throw Error("Installed plugin code was modified; reinstall this plugin");seen.add(relative);}}walk(root);if(seen.size!==expected.size)throw Error("Installed plugin code is incomplete; reinstall this plugin");}
function getVerifiedPackage(input){const info=input&&typeof input==="object"?verifiedPackages.get(input):null;if(!info)return null;if(info.disposed)throw Error("Verified plugin package was released");return info.record;}
function verifyPackageFile(file,options={}){
 const candidate=require("./package-file").readPackageFile(file,options);
 try{
  const verified=verifyMetadata(candidate),info={root:candidate.root,temporary:true,disposed:false,extracted:options.extract!==false,candidate,record:null};
  const files=Object.create(null);
  for(const entry of verified.entries)Object.defineProperty(files,entry.path,{enumerable:true,get(){if(info.disposed)throw Error("Verified plugin package was released");if(!info.extracted)throw Error("Plugin assets were not extracted");return fs.readFileSync(path.join(info.root,...entry.path.split("/"))).toString(entry.encoding);}});
  const pkg=Object.freeze({manifest:verified.manifest,files:Object.freeze(files),publicKey:candidate.publicKey,signature:candidate.signature});
  const record=Object.freeze({...verified,package:pkg,get root(){return info.root;},sourceFile:candidate.sourceFile,sourceDigest:candidate.sourceDigest,sourceBytes:candidate.sourceBytes,dispose(){if(info.disposed)return;info.disposed=true;if(info.temporary)candidate.dispose();}});
  info.record=record;verifiedPackages.set(pkg,info);return record;
 }catch(error){candidate.dispose();throw error;}
}
function bindCodeRoot(pkg,destination){const info=verifiedPackages.get(pkg);if(!info||info.disposed||!info.extracted)throw Error("A live extracted package is required");let exists=true;try{fs.lstatSync(destination);}catch(error){if(error.code!=="ENOENT")throw error;exists=false;}
 if(exists){verifyCodeRoot(destination,info.record.entries);if(info.temporary)info.candidate.dispose();}
 else{fs.renameSync(info.root,destination);for(const entry of info.record.entries)fs.chmodSync(path.join(destination,...entry.path.split("/")),/\.(?:bin|exe)$/i.test(entry.path)?0o500:0o400);}
 info.root=destination;info.temporary=false;return info.record;
}
function copyApprovedPackage(pkg,destination){const verified=getVerifiedPackage(pkg);if(!verified)throw Error("A verified package snapshot is required");let created=false;try{fs.copyFileSync(verified.sourceFile,destination,fs.constants.COPYFILE_EXCL);created=true;const copied=hashFile(destination);if(copied.bytes!==verified.sourceBytes||copied.sha256!==verified.sourceDigest)throw Error("Plugin package changed after review; review it again");fs.chmodSync(destination,0o600);}catch(error){if(created)fs.rmSync(destination,{force:true});throw error;}}
module.exports={verifyPackageFile,verifyMetadata,getVerifiedPackage,bindCodeRoot,copyApprovedPackage,hashFile,verifyCodeRoot};
