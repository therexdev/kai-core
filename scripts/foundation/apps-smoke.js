"use strict";
// Real Core + packaged plugin interfaces. Profiles are generated for this run;
// packages use pinned publisher signatures or explicit ephemeral source fixtures.
// No live account/model/chain/OAuth operation is used.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),assert=require("node:assert/strict");
const {_electron:electron}=require("playwright-core");
const appRoot=path.resolve(process.env.KAI_SMOKE_SOURCE_ROOT||path.join(__dirname,"../.."));
// Electron can load app.asar directly. Preparation uses the source verifier and
// profile code; every launched Core module comes from runtimeRoot when supplied.
const runtimeRoot=path.resolve(process.env.KAI_SMOKE_RUNTIME_ROOT||appRoot);
const sources=path.resolve(process.env.KAI_PLUGIN_SOURCES||path.join(appRoot,".."));
const packages=process.env.KAI_SMOKE_PACKAGES_DIR?path.resolve(process.env.KAI_SMOKE_PACKAGES_DIR):null;
const releases=require("./apps-publishers.json");
const {signingPayload,BINARY,verifyPackage}=require(path.join(appRoot,"core/lib/plugins/package"));
const specs=[
 ["brain","brain.ui.status",{}],["connections","connections.ui.status",{}],["workflows","workflows.status",{}],
 ["documents","documents.list",{}],["model-compare","compare.request",{path:"/core/models",method:"GET",requestId:"smoke-compare-1"}],
 ["code","code.request",{path:"/core/code/projects",method:"GET"}],["tools","tools.ui.request",{path:"/core/mcp",method:"GET",requestId:"smoke-tools-1"}],
 ["koinos-node","node.read",{channel:"app:info"}],["remote-access","remote.api",{action:"status"}],
 ["agent-network","agentNetwork.status",{}],["assistant","assistant.list",{}],
];
async function main(){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"kai-foundation-apps-"))),profile=path.join(temp,"profile");
 const output=path.resolve(process.env.KAI_FOUNDATION_APPS_OUTPUT||path.join(os.tmpdir(),"kai-foundation-apps-smoke"));fs.mkdirSync(output,{recursive:true});
 const report={platform:process.platform,realCore:true,runtimeRoot,publicNetworkResponsesMocked:false,syntheticProfile:true,ephemeralSignatures:!packages,packageMode:packages?"publisher-signed-streaming":"ephemeral-source",checks:[],plugins:[],screenshots:[],failures:[]};
 require(path.join(appRoot,"electron/foundation-profile")).prepareFoundationProfile(profile);
 fs.writeFileSync(path.join(profile,"settings.json"),JSON.stringify({network:{privacyMode:"local-only"},earn:{autoStart:false}}));
 const manager=new(require(path.join(appRoot,"core/lib/plugins/manager")).PluginManager)(profile);
 const key=packages?null:crypto.generateKeyPairSync("ed25519"),publicKey=key?.publicKey.export({format:"der",type:"spki"}).toString("base64");
 const selected=process.env.KAI_FOUNDATION_SMOKE_IDS?new Set(process.env.KAI_FOUNDATION_SMOKE_IDS.split(",")):null;
 assert.equal(releases.schema,1);assert.deepEqual(releases.plugins.map(p=>p.id).sort(),specs.map(([slug])=>"kai."+slug).sort());
 if(selected)for(const id of selected)assert.ok(specs.some(([slug])=>"kai."+slug===id),"Unknown smoke app: "+id);
 for(const[slug,method,input]of specs){
  if(selected&&!selected.has("kai."+slug))continue;
  if(packages){
   const expected=releases.plugins.find(p=>p.id==="kai."+slug);assert.match(expected.version,/^\d+\.\d+\.\d+$/);
   const installed=require("./apps-packages").installReleasedPackage(manager,path.join(packages,expected.file),expected,appRoot);
   report.plugins.push({...installed,method,input});console.log("Publisher package installed",installed.id,installed.files,"files");continue;
  }
  const repo=path.join(sources,"kai-plugin-"+slug),built=path.join(repo,".build/plugin");
  const source=slug==="assistant"&&fs.existsSync(built)?built:path.join(repo,"plugin");
  const manifest=JSON.parse(fs.readFileSync(path.join(source,"manifest.json"),"utf8")),files={};
  function walk(dir,prefix=""){for(const item of fs.readdirSync(dir,{withFileTypes:true})){if(item.isSymbolicLink())throw Error("Fixture package contains symlink");const file=prefix+item.name;if(item.isDirectory())walk(path.join(dir,item.name),file+"/");else if(file!=="manifest.json")files[file]=fs.readFileSync(path.join(dir,item.name)).toString(BINARY.test(file)?"base64":"utf8");}}
  walk(source);
  const pkg={manifest,files,publicKey,signature:crypto.sign(null,Buffer.from(signingPayload(manifest,files)),key.privateKey).toString("base64")};
  verifyPackage(pkg);manager.install(pkg,{trustNative:true});
  report.plugins.push({id:manifest.id,version:manifest.version,source,files:Object.keys(files).length,method,input});console.log("Fixture installed",manifest.id,Object.keys(files).length,"files");
 }
 const exitReport=path.join(temp,"exit.json"),syntheticKeychain=process.argv.includes("--synthetic-keychain");report.syntheticKeychain=syntheticKeychain;
 fs.writeFileSync(path.join(temp,"package.json"),JSON.stringify({name:"kai-foundation-apps-smoke",version:require(path.join(appRoot,"package.json")).version,main:"desktop.js"}));
 fs.writeFileSync(path.join(temp,"desktop.js"),`"use strict";\nrequire(${JSON.stringify(path.join(__dirname,"apps-fixture.js"))}).install(${JSON.stringify({appRoot:runtimeRoot,appData:path.join(temp,"app-data"),reportFile:exitReport,syntheticKeychain})});\nrequire(${JSON.stringify(path.join(runtimeRoot,"electron/core-main.js"))});\n`);
 const args=[];if(process.platform==="linux"&&process.getuid?.()===0)args.push("--no-sandbox");if(process.platform==="linux"&&!process.env.DISPLAY)args.push("--ozone-platform=headless");args.push(temp);
 const env={...process.env,KAI_CORE_DATA:profile,KAI_CORE_PORT:"0",KAI_CHANNEL:"core"};delete env.ELECTRON_RUN_AS_NODE;delete env.KAI_CORE_TOKEN;delete env.KAI_SESSION_SECRET;
 let application,page,logs="";const pageErrors=[];
 const appEval=(id,expression)=>application.evaluate(async(_electron,{id,expression})=>{const wc=global.__foundationHost.renderer(id);if(!wc)throw Error("Missing app renderer "+id);return wc.executeJavaScript(expression,true);},{id,expression});
 const until=async(predicate,message,timeout=30000)=>{const end=Date.now()+timeout;do{if(await predicate())return;await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);throw Error(message);};
 async function check(name,run){try{await run();report.checks.push(name);console.log("PASS",name);}catch(error){report.failures.push({name,error:error.stack||String(error)});console.error("FAIL",name,error.message);}}
 try{
  application=await electron.launch({executablePath:require("electron"),args,env,timeout:60000});
  for(const stream of[application.process().stdout,application.process().stderr])stream?.on("data",chunk=>{logs=(logs+chunk).slice(-60000);});
  page=await application.firstWindow({timeout:60000});page.setDefaultTimeout(30000);page.on("pageerror",e=>pageErrors.push(e.message));
  await application.evaluate(()=>{global.__foundationWindow?.setContentSize(1280,900);});
  await page.waitForFunction(()=>document.getElementById("version")?.textContent.startsWith("v"),{timeout:60000});
  await check("Real Core starts with fresh Foundation profile, Local-Only and all apps",async()=>{const status=await page.evaluate(()=>window.kaiCore.call("status"));assert.equal(status.profile.mode,"foundation");assert.equal(status.network.privacyMode,"local-only");assert.equal(status.wallet.exists,false);assert.equal(status.plugins.length,report.plugins.length);assert.equal(await page.locator("#apps-list .app-nav-row").count(),report.plugins.length);});
  await check("Renderer error capture is active",async()=>{
   await page.evaluate(()=>console.error("KAI_SMOKE_CAPTURE_PROBE"));
   let captured;
   for(let attempt=0;attempt<4;attempt++){
    try{
     captured=await application.evaluate(()=>{
      const state=global.__foundationSmoke,index=state.errors.findIndex(e=>e.message==="KAI_SMOKE_CAPTURE_PROBE");
      // The inspector can lose an evaluation result during startup GC after
      // this callback already ran. Keep the assertion idempotent on retry.
      if(index>=0){state.errors.splice(index,1);state.captureProbeObserved=true;}
      return state.captureProbeObserved===true;
     });
     break;
    }catch(error){
     if(!String(error.message).includes("Resulting promise was garbage collected")||attempt===3)throw error;
     await new Promise(resolve=>setTimeout(resolve,250));
    }
   }
   assert.equal(captured,true);
  });
  for(const plugin of report.plugins)await check(plugin.id+" opens its actual UI and native service",async()=>{
   await page.locator(`[data-app="${plugin.id}"]`).click();
   await until(()=>application.evaluate((_electron,id)=>{const r=global.__foundationHost.windows.get(id);return!!r?.ready&&global.__foundationHost.selected===id;},plugin.id),"App did not become ready: "+plugin.id,60000);
   const result=await appEval(plugin.id,`Promise.resolve(window.kai.call(${JSON.stringify(plugin.method)},${JSON.stringify(plugin.input)})).then(result=>({ok:true,result}),error=>({ok:false,error:String(error.message||error)}))`);
   assert.equal(result.ok,true,result.error);if(result.result?.status)assert.ok(result.result.status<400,JSON.stringify(result.result));plugin.status=result.result;
   const ui=await appEval(plugin.id,`({title:document.title,text:document.body.innerText.slice(0,6000),node:typeof require,core:typeof window.kaiCore,bridge:typeof window.kai?.call})`);
   assert.equal(ui.node,"undefined");assert.equal(ui.core,"undefined");assert.equal(ui.bridge,"function");assert.ok(ui.text.trim().length>20);plugin.ui=ui;
   const file=path.join(output,plugin.id+".png");await application.evaluate((_electron,{id,file})=>global.__foundationCapture(file,id),{id:plugin.id,file});report.screenshots.push(file);
  });
  const persistent=report.plugins.find(p=>p.id==="kai.documents")||report.plugins.find(p=>p.id!=="kai.assistant");
  if(persistent)await check("App renderer and background work survive navigation and Core tray",async()=>{
   await page.locator(`[data-app="${persistent.id}"]`).click();const before=await application.evaluate((_electron,id)=>global.__foundationHost.renderer(id).id,persistent.id);
   await appEval(persistent.id,`window.__foundationTicks=0;window.__foundationDraft="kept";window.__foundationTimer=setInterval(()=>window.__foundationTicks++,50);true`);
   await page.locator('[data-page="plugins"]').click();await application.evaluate(()=>global.__foundationWindow.close());
   await until(()=>application.evaluate(()=>!global.__foundationWindow.isVisible()),"Closing Core did not hide it in tray");
   await until(async()=>await appEval(persistent.id,"window.__foundationTicks")>=3,"Plugin heartbeat stopped in tray");
   await application.evaluate(()=>global.__foundationTray.show());await page.locator(`[data-app="${persistent.id}"]`).click();
   assert.equal(await application.evaluate((_electron,id)=>global.__foundationHost.renderer(id).id,persistent.id),before);assert.equal(await appEval(persistent.id,"window.__foundationDraft"),"kept");await appEval(persistent.id,"clearInterval(window.__foundationTimer);true");
  });
  if(report.plugins.some(p=>p.id==="kai.assistant"))await check("Assistant launch button loads its desktop companion script",async()=>{
   await page.locator('[data-app="kai.assistant"]').click();await appEval("kai.assistant",`(()=>{const button=document.getElementById("launch-kai");if(!button)throw Error("Missing launch-kai control");button.click();return true})()`);
   await until(()=>application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>/\/mascot\.html(?:[?#]|$)/.test(w.webContents.getURL()))),"Assistant companion window did not open",45000);
   await until(()=>application.evaluate(async({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>/\/mascot\.html(?:[?#]|$)/.test(w.webContents.getURL()));return win.webContents.executeJavaScript(`document.getElementById('model').options.length>0 && !/^(Connecting|Reconnecting)/.test(document.getElementById('connection').textContent)`);}),"Companion did not finish model initialization",30000);
   const result=await application.evaluate(async({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(w=>/\/mascot\.html(?:[?#]|$)/.test(w.webContents.getURL()));return window.webContents.executeJavaScript(`window.kaiDesktop.pocketStatus().then(pocket=>({script:performance.getEntriesByType('resource').some(r=>r.name.endsWith('/mascot.js')),model:!!document.getElementById('model'),pocket:!!pocket,body:document.body.innerText.slice(0,400)}))`);});
   assert.equal(result.script,true);assert.equal(result.model,true);assert.equal(result.pocket,true);await application.evaluate(()=>global.__foundationTray.show());
  });
  await check("No feature service startup failures or uncaught Core UI exceptions",async()=>{const result=await application.evaluate(()=>({errors:[...global.__foundationServices.backgroundErrors],native:global.__foundationSmoke}));report.runtime=result;assert.deepEqual(result.errors,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(result.native.errors,[]);assert.ok(!/No handler registered for/.test(logs),"Missing native IPC handler in application logs");});
  await check("Reordering apps persists through the native Core API",async()=>{const target=report.plugins.at(-1).id;await page.locator(`[data-reorder-app="${target}"]`).focus();await page.keyboard.press("Home");await until(async()=>{const status=await page.evaluate(()=>window.kaiCore.call("status"));return status.pluginsOrder[0]===target;},"App order was not saved");});
  await check("Removing installed apps revokes services and hides the Apps section",async()=>{for(const plugin of report.plugins)await page.evaluate(id=>window.kaiCore.call("plugins.change",{id,action:"remove"}),plugin.id);await page.evaluate(()=>refresh());assert.equal(await page.locator("#apps-section").isVisible(),false);const state=await application.evaluate(()=>({services:global.__foundationServices.services.size,views:global.__foundationHost.windows.size}));assert.deepEqual(state,{services:0,views:0});});
  const child=application.process(),ended=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Core did not quit after 30 seconds")),30000);child.once("exit",code=>{clearTimeout(timer);code===0?resolve():reject(Error("Core exited "+code));});});
  await application.evaluate(()=>setTimeout(()=>global.__foundationTrayMenu.find(i=>i.label==="Quit KAI Core Beta").click(),0));await ended;application=null;
  assert.equal(fs.existsSync(exitReport),true,"Core did not record a clean quit");
  report.exit=JSON.parse(fs.readFileSync(exitReport,"utf8"));assert.deepEqual(report.exit.errors,[]);assert.equal(report.exit.remainingServices,0);assert.equal(report.exit.remainingViews,0);report.checks.push("Quit drains plugin services and destroys all embedded apps");
  assert.ok(!/No handler registered for/.test(logs),"Missing native IPC handler during shutdown");
  if(report.failures.length)throw Error(`${report.failures.length} Foundation UI smoke checks failed`);
 }catch(error){report.error=error.stack||String(error);throw error;}
 finally{report.logs=logs;report.pageErrors=pageErrors;fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));if(application)await application.close().catch(()=>{});if(!process.argv.includes("--keep-profile"))fs.rmSync(temp,{recursive:true,force:true});console.log("Report",path.join(output,"report.json"));}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
