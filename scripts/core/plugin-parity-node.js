"use strict";
const path=require("node:path"),assert=require("node:assert/strict"),{NETWORKS,DEFAULT_SETTINGS}=require("../../core/lib/koinos/constants");
function createEngine({dataDir}) {
 const root=dataDir,calls=[],address="1BoatSLRHtKNngkdXEeobR76b53LETtpyT",ethAddress="0x1111111111111111111111111111111111111111";
const wallet={exists:true,unlocked:true,address,ethAddress},balances={address,koin:"10000000000",vhp:"20000000000",mana:"8000000000",formatted:{koin:"100",vhp:"200",mana:"80"}},node={network:"mainnet",docker:{ok:true,serverVersion:"synthetic"},services:[],isRunning:false,runningCount:0,autoRecover:true,health:{ok:true},op:null};
async function read(channel,payload){calls.push(channel);switch(channel){
case"app:info":return{version:"synthetic",platform:process.platform,userData:root,networks:NETWORKS,settings:structuredClone(DEFAULT_SETTINGS),minPasswordLength:8};case"wallet:status":return wallet;case"chain:balances":case"producer:balances":return balances;
case"wallet:history":return{address,network:"mainnet",available:true,observedAt:Date.now(),rows:[{kind:"transaction",id:"0x1220"+"1".repeat(64),label:"Received KOIN",counterparty:null,height:"1",timestamp:Date.now(),status:"confirmed",changes:[{asset:"KOIN",amount:"500000000",direction:"in"}]}],nextCursor:payload.cursor?null:"synthetic-older"};
case"node:status":return node;case"node:logs":return"Synthetic log";case"setup:status":return{ready:true,platform:process.platform,docker:{installed:true,running:true}};case"node:dataDir":return{path:path.join(root,"node"),defaultPath:path.join(root,"node"),hasData:false,sizeBytes:0,freeBytes:1e12};case"node:backups":return[];case"node:quickSyncInfo":return{available:true,sizeBytes:1e9,requiredBytes:5e9,freeBytes:1e12,resumeFrom:0};case"producer:status":return{mode:"local",address,matches:false,publicKey:null};case"producer:vaultStatus":return{connected:false};case"network:producers":return{network:"mainnet",available:true,activeApprox24h:10,recent2h:5,totalTracked:20};
case"dashboard:summary":return{network:NETWORKS.mainnet,wallet,node,balances,stats:null,rewards:DEFAULT_SETTINGS.rewards,price:{usdPerKoin:.2,stale:false},valuation:null,returns:null};case"rewards:status":return{config:structuredClone(DEFAULT_SETTINGS.rewards),nextRunAt:null,last:null,derived:null};case"fund:status":return{ethAddress,onrampEndpoint:"",onrampDefault:"https://example.invalid",onrampConfigured:true};case"fund:cryptoBalances":return{address:ethAddress,eth:"0.01",usdt:"15",vkoin:"2"};case"fund:ethBalance":return{address:ethAddress,balanceEth:"0.01",eth:"0.01"};case"fund:bridgeStatus":case"fund:routeCStatus":return null;default:throw Error("Unexpected synthetic channel: "+channel);}}
 return {calls,call:read,nodeMgr:{dirs:()=>({root}),cancelQuickSync(){},cancelMove(){}},settings:{get:()=>"mainnet"},stop(){}};
}
async function node(win,{js,call,click,until,capture,output}) {
 await until(win,'!!document.querySelector("#view-node h1")',"original Node renderer");
 const language=await call(win,"node.language",{});assert.equal(typeof language.language,"string");assert.ok(language.language.length>0);assert.equal(typeof language.selected,"boolean");
 assert.equal(await js(win,'document.querySelectorAll("#nav [data-view]").length'),7);
 for(const view of ["dashboard","wallet","fund","burn","node","returns","settings"]){
  await click(win,`[data-view="${view}"]`);
  await until(win,`document.querySelector('#view-${view}').classList.contains('active')`,view+" page");
  if(view==="wallet"){
   await until(win,'document.querySelector("#node-history-rows")?.children.length===1',"Node transaction history");
   await click(win,"#node-history-more");
   await until(win,'document.querySelector("#node-history-more").hidden',"older Node history loaded");
  }
  await capture(win,path.join(output,"kai.koinos-node-"+view+".png"));
 }
 for(const section of ["wallet","fund","wallet","settings"]){
  win.webContents.send("kai-plugin:navigate",{view:"koinos-node",section});
  await until(win,`document.querySelector('#view-${section}').classList.contains('active')`,"Node deep link "+section);
 }
 await click(win,'[data-view="node"]');
 assert.ok(await js(win,'!!document.querySelector("#pc-vault-connect")&&!!document.querySelector("#pc-vault-full")&&!!document.querySelector("#pc-vault-burn-full")&&!!document.querySelector("#pc-download-draft")&&!!document.querySelector("#pc-import-signed")'));
 await assert.rejects(call(win,"node.manage",{channel:"node:start",payload:{produce:true}}),/Cancelled/);
 return "Seven original Node screens; wallet history pagination; funding, Vault/Kondor and external producer controls; native-cancelled Node start; no live Docker or transactions.";
}
module.exports={createEngine,node};
