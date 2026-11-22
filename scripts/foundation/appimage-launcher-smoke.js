"use strict";
// Real packaged Linux AppImage, two launches and late package-verifier workers.
// Only a disposable profile and an in-memory-signed fixture package are used.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const assert=require("node:assert/strict"),{spawn,execFile}=require("node:child_process"),{promisify}=require("node:util");
const {launchEnv}=require("../../electron/appimage-install"),{signingPayload}=require("../../core/lib/plugins/package");
const run=promisify(execFile),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function verifyAppImageLifetime(image) {
  assert.equal(process.platform,"linux");const binary=path.resolve(image),root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"kai-image-lifetime-")));
  const extract=path.join(root,"extract"),profile=path.join(root,"profile"),ready=path.join(root,"ready.json"),trigger=path.join(root,"probe"),result=path.join(root,"result.json"),file=path.join(root,"fixture.kaiplugin");
  fs.mkdirSync(extract,{mode:0o700});fs.mkdirSync(profile,{mode:0o700});fs.writeFileSync(path.join(profile,"retained.txt"),"saved profile fixture");
  const manifest={schema:2,apiVersion:3,id:"test.appimage-lifetime",version:"1.0.0",name:"AppImage lifecycle fixture",entry:"index.html",runtime:"sandboxed",permissions:["storage.read","storage.write"]},files={"index.html":"<!doctype html><title>Disposable fixture</title>"},key=crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(file,JSON.stringify({manifest,files,publicKey:key.publicKey.export({format:"der",type:"spki"}).toString("base64"),signature:crypto.sign(null,Buffer.from(signingPayload(manifest,files)),key.privateKey).toString("base64")}),{mode:0o600});
  const paths={ready,trigger,result,file,profile},code=`
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const paths=${JSON.stringify(paths)},appdir=process.env.APPDIR;
const {verifyPackageFileAsync}=require(path.join(appdir,'resources/app.asar/core/lib/plugins/package-file-verifier.js'));
const {PluginManager}=require(path.join(appdir,'resources/app.asar/core/lib/plugins/manager.js'));
fs.writeFileSync(paths.ready,JSON.stringify({pid:process.pid,appdir}));
const timer=setInterval(async()=>{if(!fs.existsSync(paths.trigger))return;clearInterval(timer);let verified;
try{verified=await verifyPackageFileAsync(paths.file,{directory:paths.profile,extract:false});
const manager=new PluginManager(paths.profile);await manager.installAsync(verified.package);
assert.equal(manager.list()[0].id,'test.appimage-lifetime');
assert.equal(fs.readFileSync(path.join(paths.profile,'retained.txt'),'utf8'),'saved profile fixture');
fs.writeFileSync(paths.result,JSON.stringify({ok:true,id:manager.list()[0].id}));}
catch(error){fs.writeFileSync(paths.result,JSON.stringify({ok:false,error:error.stack}));}
finally{await verified?.dispose();}},50);setInterval(()=>{},1000);
`;
  // Test-only Node mode avoids a display/keyring and never starts live Core.
  // electron-builder's AppRun probes `unshare` even in Node mode. Restricted
  // CI hosts otherwise add a Chromium-only --no-sandbox flag that Node rejects.
  // Satisfy that probe only for these Node processes; no Chromium sandbox or
  // application launch policy is changed. Native desktop checks run separately.
  const testBin=path.join(root,"node-only-tools");fs.mkdirSync(testBin,{mode:0o700});fs.writeFileSync(path.join(testBin,"unshare"),"#!/bin/sh\nexit 0\n",{mode:0o700});
  const env={...launchEnv({...process.env,TMPDIR:extract,PATH:testBin+path.delimiter+process.env.PATH},binary),ELECTRON_RUN_AS_NODE:"1"};
  const child=spawn(binary,["-e",code],{env,stdio:["ignore","ignore","pipe"]});let errors="",started;
  child.stderr.on("data",chunk=>{errors=(errors+chunk).slice(-32768);});
  const closed=new Promise(resolve=>{child.once("exit",resolve);child.once("error",error=>{errors+=error.message;resolve();});});
  async function until(file,timeout){const deadline=Date.now()+timeout;while(!fs.existsSync(file)&&Date.now()<deadline)await wait(50);assert(fs.existsSync(file),errors||`Timed out waiting for ${path.basename(file)}`);}
  try {
    await until(ready,60000);started=JSON.parse(fs.readFileSync(ready));assert(fs.existsSync(started.appdir));
    await run(binary,["-e","process.exit(0)"],{env,timeout:60000,maxBuffer:4*1024*1024});
    assert(fs.existsSync(started.appdir),"Closing a second launch deleted the running application's files");
    fs.writeFileSync(trigger,"verify and install");await until(result,60000);
    const value=JSON.parse(fs.readFileSync(result));assert.equal(value.ok,true,value.error);
    console.log(`${process.arch}: second AppImage launch exited; packaged verifier workers and fixture installation passed; profile retained`);
  } finally {
    if(!started&&fs.existsSync(ready))started=JSON.parse(fs.readFileSync(ready));
    try{if(started)process.kill(started.pid,"SIGTERM");else child.kill("SIGTERM");}catch(error){if(error.code!=="ESRCH")throw error;}
    await closed;fs.rmSync(root,{recursive:true,force:true});
  }
}
if(require.main===module)verifyAppImageLifetime(process.argv[2]||"").catch(error=>{console.error(error);process.exitCode=1;});
module.exports={verifyAppImageLifetime};
