"use strict";
// Test instrumentation only. Real Core/server/manager/API/feature services run;
// no model, chain, account or remote network response is mocked.
function install({ appRoot, appData, reportFile, syntheticKeychain = false, realDialogs = false }) {
  const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),{EventEmitter}=require("node:events");
  const electron=require("electron"),{app}=electron;
  app.setPath("appData",appData);app.disableHardwareAcceleration();
  if(process.env.KAI_SMOKE_SYNTHETIC_LOCK==="1")app.requestSingleInstanceLock=()=>true;
  const state=global.__foundationSmoke={errors:[],blockedNetwork:[],dialogs:[],syntheticKeychain,syntheticTray:false};
  if(syntheticKeychain){
    const key=crypto.randomBytes(32);
    electron.safeStorage.isEncryptionAvailable=()=>true;
    electron.safeStorage.getSelectedStorageBackend=()=>"synthetic-protected-test-storage";
    electron.safeStorage.encryptString=text=>{const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,iv),data=Buffer.concat([cipher.update(String(text),"utf8"),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]);};
    electron.safeStorage.decryptString=bytes=>{const data=Buffer.from(bytes),decipher=crypto.createDecipheriv("aes-256-gcm",key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString("utf8");};
  }
  const originalFetch=global.fetch;
  global.fetch=(url,options)=>{const target=typeof url==="string"||url instanceof URL?String(url):url.url;let u;try{u=new URL(target);}catch{}
    if(!u||!["127.0.0.1","localhost","[::1]"].includes(u.hostname)){state.blockedNetwork.push(u?.origin||"invalid");return Promise.reject(Error("Smoke fixture blocks public network"));}
    return originalFetch(url,options);
  };
  electron.dialog.showErrorBox=(title,message)=>{state.errors.push({type:"startup",title,message});console.error("FOUNDATION_STARTUP_ERROR",title,message);};
  electron.dialog.showMessageBox=async(_parent,options)=>{const value=options||_parent;state.dialogs.push({title:value.title,message:value.message});return{response:value.cancelId??0};};
  // Existing smoke flows intentionally simulate native review choices. Dedicated
  // dialog UI coverage opts in to the real trusted windows with realDialogs.
  if (!realDialogs && fs.existsSync(path.join(appRoot,"electron/core-dialogs.js"))) {
    require(path.join(appRoot,"electron/core-dialogs")).createCoreDialogs = () => {
      const showMessageBox = electron.dialog.showMessageBox, showErrorBox = electron.dialog.showErrorBox;
      return { showMessageBox: (...args) => showMessageBox(...args), showErrorBox: (...args) => showErrorBox(...args), dispose() {} };
    };
  }
  electron.shell.openExternal=async()=>{throw Error("Smoke fixture does not open external applications");};
  app.on("web-contents-created",(_event,contents)=>{
    contents.on("console-message",(details)=>{if(details&&typeof details==="object"&&details.level==="error")state.errors.push({type:"console",url:contents.getURL(),message:details.message});});
    contents.on("render-process-gone",(_event,details)=>state.errors.push({type:"renderer-gone",url:contents.getURL(),message:details.reason}));
    contents.on("did-fail-load",(_event,code,message,url,mainFrame)=>{if(mainFrame&&code!==-3)state.errors.push({type:"load",url,message});});
  });
  global.__foundationCapture=async(file,id)=>{const image=await global.__foundationHost.renderer(id).capturePage();fs.writeFileSync(file,image.toPNG());};
  const hostModule=require(path.join(appRoot,"electron/core-plugin-host")),Host=hostModule.PluginHost;
  hostModule.PluginHost=class extends Host{constructor(...args){super(...args);global.__foundationHost=this;}};
  const serviceModule=require(path.join(appRoot,"electron/foundation-plugin-services")),Services=serviceModule.FoundationPluginServices;
  serviceModule.FoundationPluginServices=class extends Services{constructor(...args){super(...args);global.__foundationServices=this;}};
  const trayModule=require(path.join(appRoot,"electron/core-tray")),createTray=trayModule.createCoreTray;
  trayModule.createCoreTray=options=>{
    global.__foundationWindow=options.win;
    class HeadlessTray extends EventEmitter{setToolTip(){}setContextMenu(){}isDestroyed(){return this.destroyed===true;}destroy(){this.destroyed=true;}}
    const headless=process.platform==="linux"&&!process.env.DISPLAY;state.syntheticTray=headless;
    global.__foundationTray=createTray({...options,Tray:headless?HeadlessTray:options.Tray,Menu:{buildFromTemplate(items){global.__foundationTrayMenu=items;return options.Menu.buildFromTemplate(items);}}});return global.__foundationTray;
  };
  app.whenReady().then(()=>{if(process.platform==="linux"&&!process.env.DISPLAY)for(const key of["getDisplayMatching","getDisplayNearestPoint"]){const original=electron.screen[key].bind(electron.screen);electron.screen[key]=arg=>{const display=original(arg);return display.workArea.width<=1?{...display,workArea:{x:0,y:0,width:1280,height:900}}:display;};}});
  app.on("quit",()=>fs.writeFileSync(reportFile,JSON.stringify({...state,remainingServices:global.__foundationServices?.services.size,remainingViews:global.__foundationHost?.windows.size},null,2)));
}
module.exports={install};
