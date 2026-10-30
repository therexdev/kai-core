"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../../ui-core/account.js"),"utf8"), html=fs.readFileSync(path.join(__dirname,"../../ui-core/index.html"),"utf8");
const flush=async()=>{for(let n=0;n<6;n++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(){
 const elements=new Map();for(const[,id]of html.matchAll(/\bid="([^"]+)"/g))elements.set(id,{id,hidden:false,disabled:false,value:id==="account-grant-cap"?"10":id==="account-grant-days"?"30":"",textContent:"",innerHTML:"",href:"",events:{},classList:{toggle(){}},addEventListener(name,fn){this.events[name]=fn;}});
 const calls=[],timers=[],events={},external=[],notices=[],responses=new Map(),settings={hidden:false};let confirm=true;
 const signedOut={ok:true,scope:"website",separateCreditAccount:true,site:"https://koinosai.com",signedIn:false};
 const ctx={document:{hidden:false,getElementById:id=>{assert.ok(elements.has(id),"missing "+id);return elements.get(id);},querySelector:()=>settings},window:{KaiCoreNotice:{create:()=>({show:(text,options)=>notices.push({text,options})})},kaiCore:{call:async(method,input)=>external.push({method,input})},addEventListener:(name,fn)=>events[name]=fn,dispatchEvent(){},},
 setInterval:()=>1,clearInterval(){},setTimeout:fn=>{timers.push(fn);return timers.length;},Event:class{constructor(type){this.type=type;}},confirm:()=>confirm,
 fetch:async(url,options={})=>{calls.push({url,options});const responder=responses.get(url),value=typeof responder==="function"?await responder(options):responder||signedOut;return {ok:value.ok!==false,status:value.ok===false?400:200,json:async()=>value};},console};
 vm.runInNewContext(source,ctx);
 return{ctx,elements,$:id=>elements.get(id),calls,timers,events,external,notices,responses,signedOut,allow:value=>confirm=value};
}
test("account setup stays quiet until Settings opens and defaults to the website/Connections identity",async()=>{
 const f=fixture();assert.equal(f.calls.length,0);await f.ctx.window.KaiCoreAccount.enter();assert.equal(f.calls[0].url,"/core/website-account");assert.equal(f.$("account-signedout").hidden,false);assert.equal(f.$("account-web").hidden,true);
});
test("device code sign-in polls the existing endpoint and refreshes the signed-in account without returning a session token",async()=>{
 const f=fixture();await f.ctx.window.KaiCoreAccount.enter();
 f.responses.set("/core/website-account/link/start",{ok:true,userCode:"ABCD-1234"});
 await f.$("btn-account-signin").events.click();assert.equal(f.$("account-code").textContent,"ABCD-1234");assert.equal(f.$("account-code-row").hidden,false);
 f.responses.set("/core/website-account/link/poll",{ok:true});f.responses.set("/core/website-account",{...f.signedOut,signedIn:true,thisWalletLinked:true,account:{id:"synthetic-account",email:"user@example.test",wallets:["synthetic-wallet"]}});
 await f.timers.shift()();await flush();assert.equal(f.$("account-signedin").hidden,false);assert.equal(f.$("account-code-row").hidden,true);assert.match(f.$("account-stats").innerHTML,/user@example.test/);
 assert.ok(f.calls.some(call=>call.url==="/core/website-account/link/poll"&&call.options.method==="POST"));
});
test("Local-Only and offline errors preserve saved identity and show a dismissible explanation",async()=>{
 const f=fixture();f.responses.set("/core/website-account",{ok:false,localOnly:true,error:"blocked"});await f.ctx.window.KaiCoreAccount.enter();assert.match(f.$("account-msg").textContent,/Local-Only/);assert.equal(f.$("account-signedout").hidden,true);
 f.responses.set("/core/website-account",{ok:true,offline:true,error:"Temporary server outage"});await f.ctx.window.renderAccount(true);assert.match(f.$("account-msg").textContent,/sign-in is still saved/);assert.ok(f.notices.at(-1).options.error);
});
test("wallet linking, sign-out and credit identity selection retain separate routes",async()=>{
 const f=fixture();f.responses.set("/core/website-account/wallet",{ok:true});await f.$("btn-account-linkwallet").events.click();await flush();assert.ok(f.calls.some(call=>call.url==="/core/website-account/wallet"));
 f.responses.set("/core/website-account/logout",{ok:true});await f.$("btn-account-signout").events.click();await flush();assert.ok(f.calls.some(call=>call.url==="/core/website-account/logout"));
 await f.ctx.window.selectAccountScope(false);assert.equal(f.calls.at(-1).url,"/core/account");
});
test("native account navigation selects the requested identity instead of retaining the previous scope",async()=>{
 const f=fixture(),pages=[];let navigate;f.responses.set("/core/account",{...f.signedOut,scope:"credits"});
 const core=fs.readFileSync(path.join(__dirname,"../../ui-core/core.js"),"utf8"),registration=core.match(/bridge\?\.onOpenView\?\.\(target => \{[\s\S]*?\n\}\);/);assert.ok(registration);
 vm.runInNewContext(registration[0],{bridge:{onOpenView:fn=>navigate=fn},showPage:page=>pages.push(page),window:f.ctx.window});
 navigate({page:"settings",section:"credit-account"});await flush();assert.equal(f.calls.at(-1).url,"/core/account");assert.equal(f.$("account-heading").textContent,"AI credit account");
 navigate({page:"settings",section:"website-account"});await flush();assert.equal(f.calls.at(-1).url,"/core/website-account");assert.deepEqual(pages,["settings","settings"]);
});
test("web grants use exact caps and explicit approval; revoke targets the server-selected current-wallet grant",async()=>{
 const f=fixture();f.responses.set("/core/website-account/grant",{ok:true});f.allow(false);await f.$("btn-account-grant").events.click();assert.equal(f.calls.length,0);
 f.allow(true);await f.$("btn-account-grant").events.click();await flush();const request=f.calls.find(call=>call.url==="/core/website-account/grant");assert.deepEqual(JSON.parse(request.options.body),{maxUsd:10,days:30});
 f.responses.set("/core/website-account",{...f.signedOut,signedIn:true,thisWalletLinked:true,account:{id:"synthetic"},thisWalletGrant:{id:"current-wallet-grant",maxUsd:10,spentUsd:1,remainingUsd:9,expiresAt:Date.now()+86400000}});await f.ctx.window.renderAccount(true);
 f.responses.set("/core/website-account/grant/revoke",{ok:true});await f.$("btn-account-grant-revoke").events.click();assert.deepEqual(JSON.parse(f.calls.find(call=>call.url==="/core/website-account/grant/revoke").options.body),{id:"current-wallet-grant"});
});
test("a pending website response cannot overwrite a newly selected credit account",async()=>{
 const f=fixture();let resolve;f.responses.set("/core/website-account",()=>new Promise(done=>resolve=done));const old=f.ctx.window.KaiCoreAccount.enter();
 f.responses.set("/core/account",{...f.signedOut,scope:"credits"});await f.ctx.window.selectAccountScope(false);resolve({...f.signedOut,signedIn:true,account:{id:"stale account"}});await old;assert.equal(f.$("account-heading").textContent,"AI credit account");assert.doesNotMatch(f.$("account-stats").innerHTML,/stale account/);
});
test("verification/help links use the native external URL broker only after a click",async()=>{
 const f=fixture();let prevented=false;f.$("account-settings").events.click({target:{closest:()=>({getAttribute:()=>"https://koinosai.com/link",href:"https://koinosai.com/link"})},preventDefault(){prevented=true;}});await flush();assert.equal(prevented,true);assert.equal(f.external[0].method,"desktop.openExternal");assert.equal(f.external[0].input.url,"https://koinosai.com/link");
});
