"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {signingPayload}=require("../lib/plugins/package"),{PluginManager}=require("../lib/plugins/manager");
const {FoundationPluginServices}=require("../../electron/foundation-plugin-services"),{createFoundationApi}=require("../../electron/foundation-api");
// These executable signed fixtures exercise the public boundary, not feature engines.
// The provider follows Tools' paid-run protocol. No real credit service is contacted.
const PROVIDER=`exports.create=api=>{const call=async(method,input,ctx)=>{if(method==='background')return api.wallet.authorize('run-status',input,ctx?.signal);const opened=input?.runId?{run:{id:input.runId}}:await api.wallet.authorize('run-open',{mode:'team',budget:'2'},ctx.signal);const run=await api.wallet.authorize('run-status',opened.run.id,ctx.signal);const result=await api.wallet.authorize('run-chat',{runId:run.run.id,callId:'b'.repeat(64),request:{model:'koinos-network:remote',messages:[{role:'user',content:'Draft'}],max_tokens:10,stream:false}},ctx.signal);return {result,provider:api.plugin.id};};const release=api.services.provide('example.tools',{methods:['execute'],call});return {call:(m,i,s)=>call(m,i,{signal:s}),dispose:release};};`;
const CONSUMER=`exports.create=api=>({call:(method,input,signal)=>api.services.call('example.tools','execute',input,method==='forge'?{origin:{id:'victim'},signal}:{signal})});`;
function signed(id,source,permissions,provides=[],consumes=[]){const keys=crypto.generateKeyPairSync("ed25519"),manifest={schema:2,apiVersion:3,id,version:"1.0.0",name:id,entry:"index.html",runtime:"native",service:"service/index.js",permissions:["native.execute",...permissions],provides,consumes},files={"index.html":"<!doctype html><title>Fixture</title>","service/index.js":source};return {manifest,files,publicKey:keys.publicKey.export({format:"der",type:"spki"}).toString("base64"),signature:crypto.sign(null,Buffer.from(signingPayload(manifest,files)),keys.privateKey).toString("base64")};}
function fixture(t,{consumerWallet=true,providerWallet=true,payment}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"kai-foundation-paid-rpc-"));
 const manager=new PluginManager(directory),calls=[],id="a".repeat(64),controllers=new Map();
 manager.install(signed("example.assistant",CONSUMER,["services.call",...(consumerWallet?["wallet.authorize"]:[])],[],["example.tools"]),{trustNative:true});
 manager.install(signed("example.tools",PROVIDER,["services.provide",...(providerWallet?["wallet.authorize"]:[])],["example.tools"]),{trustNative:true});
 const entry="kai-plugin://example.assistant/index.html",wc={id:21,mainFrame:{url:entry},isDestroyed:()=>false,send:()=>{}},win={id:1,isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false},visible=new Set(["example.assistant"]);
 const ctx={core:{gateway:{network:{status:()=>({privacyMode:"network"})}},settings:{get:(_key,fallback)=>fallback}},electron:{dialog:{showMessageBox:async()=>({response:1})}},getWindow:()=>win,getWebContents:plugin=>plugin==="example.assistant"?wc:null,isVisible:plugin=>visible.has(plugin),isClosing:()=>false,
  payments:()=>({async runForPlugin(action,input,owner){calls.push({action,input,owner});owner.signal.throwIfAborted();if(payment)return payment(action,input,owner,{id,wc,visible});if(action==="run-open")return {run:{id}};if(action==="run-status")return {run:{id,mode:"team",model:"remote",state:"open"}};if(action==="run-chat")return {choices:[{message:{content:"Approved result"}}]};throw Error(action);}})};
 const services=new FoundationPluginServices({manager,createApi:record=>createFoundationApi(ctx,record)});
 const renderer=plugin=>{const controller=new AbortController();controllers.set(plugin,controller);return {...manager.load(plugin),controller,entry:plugin==="example.assistant"?entry:`kai-plugin://${plugin}/index.html`,webContents:plugin==="example.assistant"?wc:null};};
 t.after(async()=>{await services.dispose();fs.rmSync(directory,{recursive:true,force:true});});return {services,manager,renderer,calls,id,wc,visible,controllers};
}
test("a background Tools provider spends only through the initiating plugin's approved credit identity",async t=>{
 const f=fixture(t),r=await f.services.call(f.renderer("example.assistant"),"execute",{});assert.equal(r.result.choices[0].message.content,"Approved result");assert.equal(r.provider,"example.tools");assert.deepEqual(f.calls.map(c=>c.action),["run-open","run-status","run-chat"]);
 const fingerprint=f.manager.load("example.assistant").fingerprint;
 for(const {owner} of f.calls){assert.equal(owner.pluginId,"example.assistant");assert.equal(owner.fingerprint,fingerprint);assert.equal(owner.webContents,f.wc);assert.equal(owner.entry,"kai-plugin://example.assistant/index.html");assert.equal(owner.isVisible(),true);}assert.ok(f.services.services.has("example.tools"));
});
test("both the initiating plugin and provider must declare wallet authorization",async t=>{
 for(const flags of [{consumerWallet:false},{providerWallet:false}]){const f=fixture(t,flags);await assert.rejects(f.services.call(f.renderer("example.assistant"),"execute",{}),/wallet.authorize/);assert.equal(f.calls.length,0);}
});
test("a plugin cannot forge originating identity through service-call options",async t=>{const f=fixture(t);await assert.rejects(f.services.call(f.renderer("example.assistant"),"forge",{id:"victim"}),/delegated service contexts/);assert.equal(f.calls.length,0);});
test("the approved continuation keeps its original identity when its UI becomes hidden",async t=>{
 const f=fixture(t,{payment:async(action,input,owner,state)=>{if(action==="run-open"){state.visible.clear();return {run:{id:state.id}};}if(action==="run-status")return {run:{id:state.id}};assert.equal(owner.isVisible(),false);return {choices:[{message:{content:"Continued"}}]};}});
 const r=await f.services.call(f.renderer("example.assistant"),"execute",{});assert.equal(r.result.choices[0].message.content,"Continued");assert.ok(f.calls.every(c=>c.owner.pluginId==="example.assistant"));
});
test("navigation of the originating main frame invalidates the next credit operation",async t=>{
 const f=fixture(t,{payment:async(action,input,owner,state)=>{if(action==="run-open")return {run:{id:state.id}};if(action==="run-status"){state.wc.mainFrame={url:"https://invalid.example/"};return {run:{id:state.id}};}throw Error("Credit continuation should have been rejected");}});
 await assert.rejects(f.services.call(f.renderer("example.assistant"),"execute",{}),/originating plugin/);assert.deepEqual(f.calls.map(c=>c.action),["run-open","run-status"]);
});
test("stopping the initiating plugin cancels an in-flight provider credit call",async t=>{
 let entered;const started=new Promise(resolve=>entered=resolve);let paymentSignal;
 const f=fixture(t,{payment:async(action,input,owner,state)=>{if(action==="run-open")return {run:{id:state.id}};if(action==="run-status")return {run:{id:state.id}};paymentSignal=owner.signal;entered();await new Promise((resolve,reject)=>{if(owner.signal.aborted)reject(owner.signal.reason);else owner.signal.addEventListener("abort",()=>reject(owner.signal.reason),{once:true});});}});
 const pending=f.services.call(f.renderer("example.assistant"),"execute",{}),rejected=assert.rejects(pending,/stopped|closing/i);await started;await f.services.close("example.assistant");await rejected;assert.equal(paymentSignal.aborted,true);
});
test("provider background work cannot borrow a renderer or initiate credits by itself",async t=>{const f=fixture(t);await assert.rejects(f.services.call(f.renderer("example.tools"),"background",f.id),/originating plugin/);assert.equal(f.calls.length,0);});
