"use strict";
// Opt-in large-package regression probe. Uses synthetic bytes, never a user's
// profile or installed plugins. Run: node --expose-gc ... [raw MiB, default 200].
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {signingPayload,verifyPackage,packageDigest}=require("../../core/lib/plugins/package");
const {PluginManager}=require("../../core/lib/plugins/manager");
const rawMiB=Number(process.argv[2]||200);if(!Number.isInteger(rawMiB)||rawMiB<1||rawMiB>350)throw Error("Choose 1–350 raw MiB");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"kai-package-memory-")),stages=[],started=Date.now();
function stage(name){global.gc?.();const memory=process.memoryUsage();stages.push({name,elapsedMs:Date.now()-started,rssMiB:Math.round(memory.rss/1048576),heapMiB:Math.round(memory.heapUsed/1048576),externalMiB:Math.round(memory.external/1048576),maxRssMiB:Math.round(process.resourceUsage().maxRSS/1024)});}
try{
 stage("baseline");const files={"index.html":"<!doctype html><title>Large fixture</title>","service/index.js":"exports.create=()=>({call:()=>true})"};
 for(let left=rawMiB,index=0;left>0;index++){const size=Math.min(20,left);files[`service/fixture-${index}.bin`]=Buffer.alloc(size*1048576,index+1).toString("base64");left-=size;}
 const manifest={schema:2,apiVersion:3,id:"memory.fixture",name:"Large fixture",version:"1.0.0",entry:"index.html",runtime:"native",service:"service/index.js",permissions:["native.execute"],provides:[],consumes:[]};
 const keys=crypto.generateKeyPairSync("ed25519"),payload=signingPayload(manifest,files),pkg={manifest,files,publicKey:keys.publicKey.export({format:"der",type:"spki"}).toString("base64"),signature:crypto.sign(null,Buffer.from(payload),keys.privateKey).toString("base64")};
 stage("signed");const verified=verifyPackage(pkg);assert(Object.isFrozen(verified.package.files));assert.equal(verified.digest,packageDigest(pkg));assert(payload.length<10000);stage("verified-object");
 const manager=new PluginManager(root);manager.install(verified.package,{trustNative:true});stage("installed-streamed-json");
 const instance=manager.materialize("memory.fixture");assert.equal(instance.digest,verified.digest);stage("parsed-and-materialized");
 console.log(JSON.stringify({platform:process.platform,node:process.version,rawMiB,encodedMiB:Math.round(fs.statSync(path.join(manager.pluginDir("memory.fixture"),manager.state.installed["memory.fixture"].file)).size/1048576),signaturePayloadBytes:Buffer.byteLength(payload),stages},null,2));
}finally{fs.rmSync(root,{recursive:true,force:true});}
