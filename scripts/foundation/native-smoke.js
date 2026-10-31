"use strict";
// Real Electron renderer/IPC/lifecycle integration. Models, money, microphone
// hardware and native tray presence on headless Linux are not exercised.
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { _electron } = require("playwright-core");
const { signingPayload } = require("../../core/lib/plugins/package");
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-foundation-native-")), source = process.env.KAI_FOUNDATION_SOURCE_ROOT || path.resolve(__dirname,"../..");
  const output = process.env.KAI_FOUNDATION_SMOKE_OUTPUT || path.join(os.tmpdir(),"kai-foundation-native-smoke");fs.mkdirSync(output,{recursive:true});
  fs.mkdirSync(path.join(root,"profile"),{recursive:true});
  const keys=crypto.generateKeyPairSync("ed25519");
  function packageFor(id,version="1.0.0",native=true) {
    const manifest={schema:2,apiVersion:3,id,version,name:id==="community.fixture"?"Community Native Fixture":"Community Sandboxed Fixture",description:"Synthetic signed third-party fixture",entry:"index.html",runtime:native?"native":"sandboxed",permissions:native?["native.execute","storage.read","storage.write","desktop.windows","desktop.media"]:["storage.read","storage.write"],provides:[],consumes:[],...(native?{service:"service/index.js"}:{})};
    const files={"index.html":'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body><h1>Community plugin</h1><textarea id="draft"></textarea><output id="result">Ready</output><script src="app.js"></script></body></html>',"app.css":"body{background:#f4f7fd;color:#14284e;font:15px system-ui;padding:30px}textarea{display:block;width:80%;height:100px;margin:20px 0}output{display:block}","app.js":native?`window.events=0;window.kai.onEvent('fixture:tick',()=>window.events++);window.read=()=>window.kai.call('fixture.state',{});window.wait=()=>window.kai.call('fixture.wait',{});window.kai.call('fixture.state',{}).then(value=>document.getElementById('result').textContent=value.owned);`:'window.kai.call("storage.set",{key:"loaded",value:true});'};
    if(native)Object.assign(files,{
      "service/node_modules/example-owned/package.json":JSON.stringify({name:"example-owned",version,main:"index.js"}),
      "service/node_modules/example-owned/index.js":`module.exports=${JSON.stringify("owned dependency "+version)};`,
      "service/index.js":`const fs=require('node:fs'),path=require('node:path'),owned=require('example-owned');exports.create=api=>{const file=path.join(api.plugin.dataDir,'lifecycle.json');const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};const save=()=>fs.writeFileSync(file,JSON.stringify(state));state.creates=(state.creates||0)+1;save();let ticks=0,timer;return{startBackground(){if(timer)return;state.starts=(state.starts||0)+1;save();timer=setInterval(()=>{ticks++;api.desktop.send('fixture:tick',{ticks})},30)},call(method,input,signal){if(method==='fixture.state')return{owned,ticks,version:api.plugin.version,creates:state.creates};if(method==='fixture.wait')return new Promise((resolve,reject)=>{const stop=()=>reject(Error('revoked'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})});throw Error('Unknown fixture method')},dispose(){clearInterval(timer);state.disposes=(state.disposes||0)+1;save();}}};`
    });
    return{manifest,files,publicKey:keys.publicKey.export({format:"der",type:"spki"}).toString("base64"),signature:crypto.sign(null,Buffer.from(signingPayload(manifest,files)),keys.privateKey).toString("base64")};
  }
  const native=packageFor("community.fixture"),sandbox=packageFor("community.sandbox","1.0.0",false),update=packageFor("community.fixture","1.1.0");
  for(const[name,pkg]of Object.entries({native,sandbox,update}))fs.writeFileSync(path.join(root,name+".json"),JSON.stringify(pkg));
  fs.writeFileSync(path.join(root,"shell.html"),'<!doctype html><html><body style="background:#f4f7fd;font:16px system-ui"><h1>KAI Foundation host fixture</h1><p>Real isolated plugin views are embedded below.</p></body></html>');
  const entry=`"use strict";
const fs=require('node:fs'),path=require('node:path'),electron=require('electron'),{EventEmitter}=require('node:events');
const root=${JSON.stringify(root)},source=${JSON.stringify(source)};process.on('uncaughtException',error=>{fs.writeFileSync(path.join(root,'startup-error.txt'),error.stack);electron.app.exit(1)});electron.app.setName('KAI Foundation Native Test');electron.app.setPath('userData',path.join(root,'profile'));electron.app.disableHardwareAcceleration();
electron.protocol.registerSchemesAsPrivileged([{scheme:'kai-plugin',privileges:{standard:true,secure:true}}]);
electron.app.on('window-all-closed',()=>{});
const handlers=new Map(),realFrom=electron.session.fromPartition.bind(electron.session),dialogs=[];
const shim={...electron,dialog:{...electron.dialog,showMessageBox:async(_window,options)=>{dialogs.push(options);return{response:1}}},session:{fromPartition(name){const session=realFrom(name),set=session.setPermissionRequestHandler.bind(session);session.setPermissionRequestHandler=handler=>{handlers.set(session,handler);return set(handler)};return session;}}};
global.__foundationApp=electron.app;global.__foundationProgress='waiting-ready';electron.app.whenReady().then(async()=>{global.__foundationProgress='ready';
 const {PluginManager}=require(path.join(source,'core/lib/plugins/manager')),{FoundationPluginServices}=require(path.join(source,'electron/foundation-plugin-services')),{PluginHost}=require(path.join(source,'electron/core-plugin-host')),{createFoundationApi}=require(path.join(source,'electron/foundation-api'));
 const manager=new PluginManager(path.join(root,'profile'));manager.install(JSON.parse(fs.readFileSync(path.join(root,'native.json'))),{trustNative:true});manager.install(JSON.parse(fs.readFileSync(path.join(root,'sandbox.json'))));
 global.__foundationProgress='installed';const win=new electron.BrowserWindow({width:1100,height:800,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadFile(path.join(root,'shell.html'));
 // Ozone headless can report a 1x1 work area and clamp constructor dimensions.
 // Give this synthetic host real drawable space; production visibility checks
 // must still reject zero-size or hidden plugin views.
 if(process.platform==='linux'&&!process.env.DISPLAY)win.setContentSize(1100,800);
 global.__foundationProgress='shell-loaded';
 let host;const core={gateway:{port:1,network:{status:()=>({privacyMode:'local-only'}),trackShadowRequest:()=>()=>{}}},models:{aliases:()=>[]},runtime:{status:()=>({})},settings:{get:(_key,fallback)=>fallback},account:{origin:()=>'',_token:()=>null}};
 const services=new FoundationPluginServices({manager,createApi:record=>createFoundationApi({core,electron:shim,getWindow:()=>win,getWebContents:id=>host?.renderer(id),isVisible:id=>host?.isVisible(id)||false,openPlugin:id=>host.open(id),openCoreView:()=>host.hide(),setPrivacyMode:()=>{},isClosing:()=>false,payments:()=>({}),wallet:()=>({})},record)});
 const originalCall=services.call.bind(services);services.call=async(record,method,input)=>{try{return await originalCall(record,method,input)}catch(error){if(method==='fixture.wait')global.__foundation.waitRevoked=(global.__foundation.waitRevoked||0)+1;throw error}};
 host=new PluginHost({electron:shim,manager,core,features:services,getContainerWindow:()=>win,onActivate:()=>{}});
 let fakeTray=process.platform==='linux'&&!process.env.DISPLAY;class FixtureTray extends EventEmitter{setToolTip(){}setContextMenu(menu){this.menu=menu}isDestroyed(){return !!this.dead}destroy(){this.dead=true}}
 const tray=require(path.join(source,'electron/core-tray')).createCoreTray({app:electron.app,win,Tray:fakeTray?FixtureTray:electron.Tray,Menu:electron.Menu,nativeImage:electron.nativeImage,iconDirectory:path.join(source,'build'),isQuitting:()=>false});
 global.__foundationProgress='background-start';await services.startInstalledBackground();global.__foundationProgress='background-started';
 global.__foundation={manager,services,host,win,tray,handlers,dialogs,fakeTray,root,ready:true,loadUpdate(){return JSON.parse(fs.readFileSync(path.join(root,'update.json'),'utf8'));},lifecycle(){return JSON.parse(fs.readFileSync(path.join(manager.dataDir('community.fixture'),'lifecycle.json'),'utf8'));},async stop(){try{await host.closeAll();await services.dispose();}finally{tray.dispose();if(!win.isDestroyed())win.destroy();electron.app.quit();}}};
}).catch(error=>{console.error(error.stack);electron.app.exit(1)});
`;
  fs.writeFileSync(path.join(root,"fixture.js"),entry);
  const args=[];if(process.platform==="linux"&&process.getuid?.()===0)args.push("--no-sandbox");if(process.platform==="linux"&&!process.env.DISPLAY)args.push("--ozone-platform=headless");args.push(path.join(root,"fixture.js"));
  let app,logs="";const report={platform:process.platform,source,syntheticProfile:true,nativeDevicesTested:false,checks:[]};
  const check=async(name,fn)=>{console.log("Checking: "+name);await fn();report.checks.push(name);};
  const evaluate=(fn,arg)=>app.evaluate(fn,arg);
  const inPlugin=expression=>evaluate(async(_electron,expression)=>global.__foundation.host.renderer("community.fixture").executeJavaScript(expression,true),expression);
  const until=async fn=>{const end=Date.now()+10000;do{const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,40));}while(Date.now()<end);throw Error("Native fixture timed out");};
  try{
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({executablePath:require("electron"),args,env,timeout:30000});for(const stream of[app.process().stdout,app.process().stderr])stream?.on("data",chunk=>logs=(logs+chunk).slice(-20000));
    await until(()=>evaluate(()=>global.__foundation?.ready));
    report.syntheticTray=await evaluate(()=>global.__foundation.fakeTray);
    await check("Native plugin starts before its UI and owns its package dependency",async()=>{const state=await evaluate(async()=>{const f=global.__foundation,record=await f.services.ensure('community.fixture');return record.service.call('fixture.state',{},record.controller.signal)});assert.equal(state.creates,1);assert.equal(state.owned,"owned dependency 1.0.0");});
    await evaluate(async()=>{await global.__foundation.host.open('community.fixture',{x:0,y:100,width:1100,height:700})});
    await check("Generic third-party UI is sandboxed and exposes SDK3",async()=>{assert.deepEqual(await inPlugin("({require:typeof require,process:typeof process,api:window.kai.apiVersion})"),{require:"undefined",process:"undefined",api:3});await until(async()=>await inPlugin("document.getElementById('result').textContent") === "owned dependency 1.0.0");});
    const originalId=await evaluate(()=>global.__foundation.host.renderer('community.fixture').id);
    await check("Navigating to another app preserves native work, renderer and draft",async()=>{await inPlugin("document.getElementById('draft').value='Keep this draft'");const before=await inPlugin("window.read()");await evaluate(async()=>global.__foundation.host.open('community.sandbox',{x:0,y:100,width:1100,height:700}));await until(async()=>{const value=await inPlugin("window.read()");return value.ticks>before.ticks;});await evaluate(async()=>global.__foundation.host.open('community.fixture'));assert.equal(await evaluate(()=>global.__foundation.host.renderer('community.fixture').id),originalId);assert.equal(await inPlugin("document.getElementById('draft').value"),"Keep this draft");});
    await check("Close-to-tray leaves plugin service active and returning keeps its UI",async()=>{assert(await evaluate(()=>global.__foundation.tray.available));const before=await inPlugin("window.read()");await evaluate(()=>global.__foundation.win.close());assert.equal(await evaluate(()=>global.__foundation.win.isVisible()),false);await until(async()=>{const value=await inPlugin("window.read()");return value.ticks>before.ticks;});await evaluate(()=>global.__foundation.tray.show());assert.equal(await evaluate(()=>global.__foundation.win.isVisible()),true);assert.equal(await evaluate(()=>global.__foundation.host.renderer('community.fixture').id),originalId);});
    await check("Media permission review is available to any declared publisher and rejects wrong frames",async()=>{
      const geometry=await evaluate(()=>{const f=global.__foundation,r=f.host.windows.get('community.fixture');return{visible:f.host.isVisible('community.fixture'),contentSize:f.win.getContentSize(),viewBounds:r.view.getBounds()};});
      report.mediaReviewGeometry=geometry;
      assert(geometry.visible&&geometry.viewBounds.width>0&&geometry.viewBounds.height>0,"Media review requires a visible, nonzero fixture view: "+JSON.stringify(geometry));
      const value=await evaluate(async()=>{const f=global.__foundation,wc=f.host.renderer('community.fixture'),handler=f.handlers.get(wc.session);const ask=details=>new Promise(resolve=>handler(wc,'media',resolve,details));const correct={isMainFrame:true,requestingUrl:'kai-plugin://community.fixture/index.html',mediaTypes:['audio']};return{allowed:await ask(correct),wrongFrame:await ask({...correct,isMainFrame:false}),title:f.dialogs.at(-1)?.title};});assert.equal(value.allowed,true);assert.equal(value.wrongFrame,false);assert.match(value.title,/Community Native Fixture/);
    });
    await check("Renderer reload retains native state and reconnects its event API",async()=>{const before=await inPlugin("window.read()");await evaluate(()=>global.__foundation.host.renderer('community.fixture').reload());await until(async()=>{try{return await inPlugin("typeof window.read==='function'&&document.getElementById('result').textContent==='owned dependency 1.0.0'")}catch{return false}});const after=await inPlugin("window.read()");assert.equal(after.creates,1);assert(after.ticks>=before.ticks);await until(async()=>await inPlugin("window.events")>0);});
    await check("Disable revokes a pending call, stops the service and destroys its view",async()=>{await evaluate(()=>{void global.__foundation.host.renderer("community.fixture").executeJavaScript("window.wait().catch(()=>null)",true).catch(()=>{});});await until(()=>evaluate(()=>global.__foundation.services.pending.size>0));await evaluate(async()=>{const f=global.__foundation;await f.host.close('community.fixture','disable');f.manager.change('community.fixture','disable')});assert.equal(await evaluate(()=>global.__foundation.waitRevoked),1);assert.equal(await evaluate(()=>global.__foundation.services.pending.size),0);assert.equal(await evaluate(()=>global.__foundation.host.renderer('community.fixture')===undefined),true);assert.equal(await evaluate(()=>global.__foundation.services.records.has('community.fixture')),false);});
    await check("Update verifies new code and starts a fresh owned dependency with retained data",async()=>{await evaluate(async()=>{const f=global.__foundation;f.manager.install(f.loadUpdate(),{trustNative:true});await f.services.startInstalledBackground(f.manager,'community.fixture');await f.host.open('community.fixture',{x:0,y:100,width:1100,height:700})});await until(async()=>await inPlugin("document.getElementById('result').textContent")==="owned dependency 1.1.0");const state=await inPlugin("window.read()");assert.equal(state.version,"1.1.0");assert.equal(state.creates,2);assert.equal(await evaluate(()=>global.__foundation.host.renderer('community.fixture').id===global.__foundation.win.webContents.id),false);});
    await check("App shutdown disposes native services before exit",async()=>{await evaluate(async()=>{const f=global.__foundation;await f.host.closeAll();await f.services.dispose();});const state=await evaluate(()=>global.__foundation.lifecycle());assert.equal(state.disposes,2);assert.equal(await evaluate(()=>global.__foundation.services.records.size),0);});
    report.status="passed";console.log(JSON.stringify(report,null,2));
  }catch(error){report.status="failed";report.error=error.stack;report.logs=logs;if(fs.existsSync(path.join(root,"startup-error.txt")))report.startupError=fs.readFileSync(path.join(root,"startup-error.txt"),"utf8");if(app)report.debug=await evaluate(({app,BrowserWindow})=>({progress:global.__foundationProgress,appPath:app.getAppPath(),windows:BrowserWindow.getAllWindows().map(w=>({url:w.webContents.getURL(),loading:w.webContents.isLoading()}))})).catch(e=>({error:e.message}));throw error;}
  finally {
    // Playwright's default app.close() first closes the window; Core's tray
    // handler deliberately prevents that. Ask this exact fixture to dispose
    // and quit, then await its owned process before deleting the Windows profile.
    if(app) {
      const child=app.process(), exited=()=>child.exitCode!==null||child.signalCode!==null;
      const bounded=async(promise,ms)=>{let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}};
      const ended=exited()?Promise.resolve(true):new Promise(resolve=>child.once("exit",()=>resolve(true)));
      if(!exited())await bounded(evaluate(async()=>{if(global.__foundation)await global.__foundation.stop();else{const app=global.__foundationApp;if(app)app.exit(1);}}).catch(()=>false),5000);
      if(!exited())await bounded(ended,5000);
      if(!exited()) {
        report.cleanupForced=true;child.kill("SIGKILL");await bounded(ended,3000);
        if(report.status==="passed"){report.status="failed";report.error="Native fixture did not exit after its explicit shutdown";process.exitCode=1;}
      }
      report.processExited=exited();
    }
    fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,"electron.log"),logs);
    fs.rmSync(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
  }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
