"use strict";
// Real Electron renderer + original companion action handlers. All profile,
// account, filesystem-dialog and external service responses are synthetic.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { _electron: electron } = require("playwright-core");
async function main() {
  const core = path.resolve(__dirname, "../.."), workspace = path.dirname(core), temp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-brain-connections-parity-"));
  const screenshotDir = process.env.KAI_PARITY_SCREENSHOTS || path.join(temp, "screenshots"); fs.mkdirSync(screenshotDir, { recursive: true });
  fs.writeFileSync(path.join(temp,"package.json"), JSON.stringify({main:"main.js"}));
  fs.writeFileSync(path.join(temp,"preload.js"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('kai',{call:(method,input)=>ipcRenderer.invoke('parity:call',method,input)});`);
  fs.writeFileSync(path.join(temp,"main.js"), `"use strict";
const {app,BrowserWindow,ipcMain}=require('electron'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
const core=${JSON.stringify(core)},workspace=${JSON.stringify(workspace)},feature=process.env.KAI_PARITY_FEATURE;
const {CompanionHub,manageCompanion}=require(path.join(core,'electron/companion-hub.js'));
const {createUi}=require(path.join(core,'electron/plugin-services/companion-feature-ui.js'));
const safeStorage={isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'synthetic-fixture',encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()};
const external=[];let window,hub;
app.whenReady().then(async()=>{
 const dataDir=path.join(__dirname,'synthetic-'+feature);
 const models=()=>[];
 hub=new CompanionHub({dataDir,safeStorage,privacyMode:()=> 'local-only',models,canUseModel:()=>false,runLocal:async()=> 'Synthetic local reply',withAgentNetwork:false,chats:{list:()=>[]},account:{origin:()=>null,_token:()=>null},openExternal:async()=>{throw Error('Unexpected external browser');},fetchImpl:async(url)=>{external.push(String(url));throw Error('Unexpected external request');}});
 const calls=[];const dialogs={showOpenDialog:async()=>({canceled:true,filePaths:[]}),showSaveDialog:async()=>({canceled:true})};
 const ctx={core:{account:{_token:()=>null}},getCompanionStore:()=>hub.store,getLegacyHub:()=>hub,legacyManage:(name,action,input,signal)=>manageCompanion(hub,{dialog:dialogs,window,signal:signal||new AbortController().signal,confirm:async()=>true},action,input)};
 const ui=createUi(ctx,feature);
 ipcMain.handle('parity:call',async(_event,method,input)=>{calls.push({method,input});if(method.startsWith('desktop.'))return{};return ui.call(method,input);});
 global.__parity={calls,external,hub};
 window=new BrowserWindow({width:1280,height:900,show:true,webPreferences:{preload:path.join(__dirname,'preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:process.platform==='linux'&&!process.env.DISPLAY}});
 await window.loadFile(path.join(workspace,'kai-plugin-'+feature,'plugin/index.html'));
});
app.on('window-all-closed',()=>{hub?.stop();app.quit();});
`);
  for (const feature of ["brain","connections"]) {
    const args = [temp]; if(process.platform==="linux"&&process.getuid?.()===0)args.unshift("--no-sandbox");if(process.platform==="linux"&&!process.env.DISPLAY)args.unshift("--ozone-platform=headless");
    const app=await electron.launch({executablePath:require("electron"),args,env:{...process.env,KAI_PARITY_FEATURE:feature},timeout:30000});
    try {
      const page=await app.firstWindow(),errors=[];page.on("pageerror",error=>errors.push(error.message));
      await page.setViewportSize({width:1280,height:900}); await page.waitForSelector(".hub-rail"); page.setDefaultTimeout(10000);
      if(feature==="brain"){
        for(const section of ["overview","map","notes","goals","sources","sync","awareness","orchestration"]){
          await page.locator(`[data-hub-action="tab"][data-id="${section}"]`).click();await page.waitForSelector(".bn-main");
          assert.equal(await page.locator(".hub-rail .active").getAttribute("data-id"),section);
          assert.ok((await page.locator(".hub-content").textContent()).trim().length>40,section);
        }
        await page.locator('[data-hub-action="tab"][data-id="notes"]').click();
        await page.locator('[data-hub-action="newNote"]').click();
        await page.locator('[name="title"]').fill("Preserved original memory editor");await page.locator('[name="text"]').fill("A synthetic memory written through the original Brain store.");
        await page.locator('[data-hub-form="note"] button.primary').click();
        await page.getByRole("heading",{name:"Preserved original memory editor"}).waitFor();
        assert.equal(await app.evaluate(()=>global.__parity.hub.store.data.notes[0].text),"A synthetic memory written through the original Brain store.");
        await page.locator('[data-hub-action="tab"][data-id="awareness"]').click();
        assert.ok(await page.locator('[data-brain-form="awareness"]').count());
        await page.locator('[data-hub-action="tab"][data-id="overview"]').click();
      }else{
        await page.waitForSelector(".cn-app-card");assert.equal(await page.locator(".cn-app-card").count(),72);
        await page.locator("#cn-search").fill("Google Drive");
        await page.waitForFunction(()=>[...document.querySelectorAll('.cn-app-card strong')].some(e=>e.textContent==='Google Drive'));
        await page.locator('.cn-app-card').first().click();await page.waitForSelector('.cn-drawer');
        await page.locator('[data-cn="close"]').click();
        for(const section of ["connected","setup","apis","tools"]){await page.locator(`[data-hub-action="tab"][data-id="${section}"]`).click();assert.equal(await page.locator('.hub-rail .active').getAttribute('data-id'),section);}
        await page.locator('[data-hub-action="tab"][data-id="apis"]').click();await page.locator('[data-hub-action="newConnection"]').click();
        await page.locator('[name="name"]').fill("Synthetic custom API");await page.locator('[name="baseUrl"]').fill("https://example.test");await page.locator('[name="secret"]').fill("synthetic-private-token");
        await page.locator('[name="operations"]').fill(JSON.stringify([{id:"read",name:"Read",method:"GET",path:"/items"}]));
        await page.locator('[data-hub-form="connection"] button.primary').click();await page.getByRole("heading",{name:"Synthetic custom API"}).waitFor();
        assert.equal(await app.evaluate(()=>global.__parity.hub.store.data.connections[0].secret),"synthetic-private-token");
        assert.equal(await page.locator('input[type="password"]').count(),0);
        await page.locator('[data-hub-action="tab"][data-id="explore"]').click();
      }
      assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(()=>global.__parity.external),[]);
      if (process.env.KAI_PARITY_SCREENSHOTS) await page.screenshot({path:path.join(screenshotDir,feature+".png"),fullPage:false,animations:"disabled",timeout:30000});
      console.log("PASS "+feature+": original sections, native renderer and original action handlers; no renderer errors or external requests.");
    }finally{await app.close();}
  }
  console.log("Screenshots: "+screenshotDir);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
