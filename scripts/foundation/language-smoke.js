// Real Core IPC and views; synthetic profile, keys and single-instance lock. No live accounts or payments.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'../..'),{_electron}=require(path.join(source,'node_modules/playwright-core'));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kai-language-')),profile=path.join(temp,'profile'),screens=path.join(temp,'screens');fs.mkdirSync(screens);
require(path.join(source,'electron/foundation-profile')).prepareFoundationProfile(profile);
fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({network:{privacyMode:'local-only'},earn:{autoStart:false}}));
const {signingPayload}=require(path.join(source,'core/lib/plugins/package')),keys=crypto.generateKeyPairSync('ed25519'),manager=new(require(path.join(source,'core/lib/plugins/manager')).PluginManager)(profile);
const fixture=(id,native)=>{
 const manifest={schema:2,apiVersion:3,id,version:'1.0.0',name:id,entry:'index.html',runtime:native?'native':'sandboxed',permissions:native?['native.execute']:[],provides:[],consumes:[],...(native?{service:'service.js'}:{})};
 const files={'index.html':'<!doctype html><html><body><h1>Settings</h1><textarea id="draft"></textarea><p id="user" translate="no">Settings</p><script src="locales/catalogs.js"></script><script src="i18n.js"></script><script src="core-language.js"></script></body></html>',
 'locales/catalogs.js':fs.readFileSync(path.join(source,'ui-core/locales/catalogs.js'),'utf8'),'i18n.js':fs.readFileSync(path.join(source,'ui-core/i18n.js'),'utf8'),'core-language.js':fs.readFileSync(path.join(source,'examples/localized-notes/core-language.js'),'utf8')};
 if(native)files['service.js']='exports.create=api=>{let seen=[];api.locale.onChange(value=>seen.push(value.language));return{call(method){if(method==="fixture.locale")return{state:api.locale.get(),seen};throw Error("Unknown fixture method")},dispose(){}}};';
 manager.install({manifest,files,publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64'),signature:crypto.sign(null,Buffer.from(signingPayload(manifest,files)),keys.privateKey).toString('base64')},{trustNative:true});
};fixture('example.locale-sandbox',false);fixture('example.locale-native',true);
fs.writeFileSync(path.join(temp,'package.json'),JSON.stringify({name:'kai-language-test',version:'1.0.0',main:'desktop.js'}));
fs.writeFileSync(path.join(temp,'desktop.js'),`require(${JSON.stringify(path.join(source,'scripts/foundation/apps-fixture.js'))}).install(${JSON.stringify({appRoot:source,appData:path.join(temp,'app-data'),reportFile:path.join(temp,'exit.json'),syntheticKeychain:true})});require(${JSON.stringify(path.join(source,'electron/core-main.js'))});`);
const env={...process.env,KAI_CORE_DATA:profile,KAI_CORE_PORT:'0',KAI_CHANNEL:'core'};delete env.ELECTRON_RUN_AS_NODE;delete env.KAI_SESSION_SECRET;delete env.KAI_CORE_TOKEN;
const args=[...(process.getuid?.()===0?['--no-sandbox']:[]),...(!process.env.DISPLAY?['--ozone-platform=headless']:[]),temp];
let app,errors=[];
const launch=async()=>{app=await _electron.launch({executablePath:require(path.join(source,'node_modules/electron')),args,env,timeout:60000});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);await page.waitForFunction(()=>document.getElementById('version')?.textContent.startsWith('v'));return page;};
const plugin=(id,code)=>app.evaluate((_e,{id,code})=>global.__foundationHost.renderer(id).executeJavaScript(code,true),{id,code});
(async()=>{try{
 let page=await launch();await page.locator('#language-dialog').waitFor({state:'visible'});
 await page.locator('#first-language').selectOption('es');assert.equal(await page.locator('#language-title').innerText(),'Elige tu idioma');
 await page.screenshot({path:path.join(screens,'first-launch-es.png')});await page.locator('#language-continue').click();await page.locator('#language-dialog').waitFor({state:'hidden'});
 assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'))).interface.language,'es');
 await page.locator('#chat-input').fill('Settings — Hola <script> & 123');
 for(const id of ['example.locale-sandbox','example.locale-native']){await page.evaluate(id=>window.kaiCore.call('plugins.open',{id,bounds:{x:230,y:100,width:900,height:600}}),id);await plugin(id,'window.kaiLanguageReady');assert.equal(await plugin(id,'document.documentElement.lang'),'es');await plugin(id,'document.getElementById("draft").value="My draft Settings"');}
 await page.evaluate(()=>window.kaiCore.call('plugins.hide'));
 await page.locator('[data-page="settings"]').click();await page.locator('#interface-language').selectOption('de');await page.locator('#language-save').click();await page.waitForFunction(()=>document.documentElement.lang==='de');
 for(const id of ['example.locale-sandbox','example.locale-native']){assert.equal(await plugin(id,'document.documentElement.lang'),'de');assert.equal(await plugin(id,'document.querySelector("h1").textContent'),'Einstellungen');assert.equal(await plugin(id,'document.getElementById("draft").value'),'My draft Settings');assert.equal(await plugin(id,'document.getElementById("user").textContent'),'Settings');}
 const result=await plugin('example.locale-native','window.kai.call("fixture.locale")');assert.equal(result.state.language,'de');assert.ok(result.seen.includes('de'));
 assert.equal(await page.locator('#chat-input').inputValue(),'Settings — Hola <script> & 123');await page.screenshot({path:path.join(screens,'settings-de.png')});
 await assert.rejects(page.evaluate(()=>window.kaiCore.locale.set('xx')));assert.equal(await page.evaluate(()=>document.documentElement.lang),'de');
 await app.close();app=null;page=await launch();await page.evaluate(()=>window.kaiLanguageReady);assert.equal(await page.locator('#language-dialog').isVisible(),false);assert.equal(await page.evaluate(()=>document.documentElement.lang),'de');
 for(const lang of ['en','es','pt-BR','fr','de']){await page.evaluate(lang=>window.kaiCore.locale.set(lang),lang);await page.waitForFunction(lang=>document.documentElement.lang===lang,lang);await page.locator('[data-page="settings"]').click();assert.ok(!(await page.locator('#language-settings').innerText()).includes('[object Object]'));}
 await page.screenshot({path:path.join(screens,'settings-final.png')});assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:14,screens,errors}));
 }finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
