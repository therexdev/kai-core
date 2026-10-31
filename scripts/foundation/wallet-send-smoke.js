"use strict";
// Real Electron/Core send UI with a disposable wallet and synthetic chain reads.
// No production wallet, network transfer or blockchain transaction is used.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict");
const appRoot=path.resolve(__dirname,"../..");
function fixture() {
 const {ChainService}=require(path.join(appRoot,"core/lib/koinos/chain"));
 const {WalletHistory}=require(path.join(appRoot,"core/lib/koinos/wallet-history"));
 const chain=require(path.join(appRoot,"core/lib/koin-network/payment-network")).MAINNET_CHAIN;
 ChainService.prototype.balances=async()=>({koin:"1000000000",vhp:"123456789123456789",mana:"900000000"});
 ChainService.prototype.provider=()=>({getChainId:async()=>chain});
 ChainService.prototype.transfer=()=>{throw Error("Smoke must never submit a transfer");};
 WalletHistory.prototype.read=async function(){return{address:global.__walletSendAddress,network:"mainnet",tokenSymbol:"KOIN",available:true,rows:[],nextCursor:null,observedAt:Date.now()};};
 // Exercise the real approval dialog while preventing an external RPC.
 const mod=require(path.join(appRoot,"electron/core-wallet")),create=mod.createCoreWallet;
 mod.createCoreWallet=options=>create(options,{chainFactory:settings=>new ChainService(settings)});
}
async function main(){
 const {_electron}=require("playwright-core"),temp=fs.mkdtempSync(path.join(os.tmpdir(),"kai-wallet-send-")),profile=path.join(temp,"profile"),output=path.resolve(process.env.KAI_WALLET_SMOKE_OUTPUT||path.join(os.tmpdir(),"kai-wallet-send-smoke"));fs.mkdirSync(output,{recursive:true});
 require(path.join(appRoot,"electron/foundation-profile")).prepareFoundationProfile(profile);
 fs.writeFileSync(path.join(profile,"settings.json"),JSON.stringify({network:{privacyMode:"local-only"},earn:{autoStart:false}}));
 const {WalletService}=require(path.join(appRoot,"core/lib/wallet")),wallet=new WalletService(path.join(profile,"wallet")),password="synthetic-send-smoke-password";
 wallet.create({password});const address=wallet.address;wallet.lock();
 fs.writeFileSync(path.join(temp,"package.json"),JSON.stringify({name:"kai-wallet-send-smoke",version:"1.0.0",main:"desktop.js"}));
 fs.writeFileSync(path.join(temp,"desktop.js"),`require(${JSON.stringify(path.join(__dirname,"apps-fixture.js"))}).install(${JSON.stringify({appRoot,appData:path.join(temp,"app-data"),reportFile:path.join(temp,"exit.json"),syntheticKeychain:true,realDialogs:true})});global.__walletSendAddress=${JSON.stringify(address)};require(${JSON.stringify(__filename)}).fixture();require(${JSON.stringify(path.join(appRoot,"electron/core-main.js"))});`);
 const args=[];if(process.platform==="linux"&&process.getuid?.()===0)args.push("--no-sandbox");if(process.platform==="linux"&&!process.env.DISPLAY)args.push("--ozone-platform=headless");args.push(temp);
 const env={...process.env,KAI_CORE_DATA:profile,KAI_CORE_PORT:"0",KAI_CHANNEL:"core"};delete env.ELECTRON_RUN_AS_NODE;delete env.KAI_SESSION_SECRET;delete env.KAI_CORE_TOKEN;
 let app;const errors=[],report={syntheticWallet:true,syntheticChain:true,liveTransfers:false,checks:[]};
 try{
 app=await _electron.launch({executablePath:require("electron"),args,env,timeout:60000});const page=await app.firstWindow();page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(30000);
 await app.evaluate(()=>global.__foundationWindow.setContentSize(1280,900));await page.waitForFunction(()=>document.getElementById("version")?.textContent.startsWith("v"));
 await page.locator('[data-page="wallet"]').click();await page.locator("#password").fill(password);await page.locator("#unlock-button").click();
 await page.waitForFunction(()=>!document.getElementById("wallet-open-send").disabled);await page.locator("#wallet-open-send").click();
 await page.locator("#wallet-send-panel").waitFor({state:"visible"});assert.equal(await page.locator("#wallet-send-panel").evaluate(n=>n.matches(":modal")),true);
 await page.locator("#wallet-send-all").click();await page.waitForFunction(()=>document.getElementById("wallet-send-amount").value==="8");assert.match(await page.locator("#wallet-send-message").innerText(),/mana/);
 await page.screenshot({path:path.join(output,"core-send-koin.png")});
 await page.locator("#wallet-send-token").selectOption("vhp");assert.equal(await page.locator("#wallet-send-amount").inputValue(),"");await page.locator("#wallet-send-all").click();await page.waitForFunction(()=>document.getElementById("wallet-send-amount").value==="1234567891.23456789");
 await page.screenshot({path:path.join(output,"core-send-vhp.png")});
 await page.locator("#wallet-send-password").fill(password);await page.locator("#wallet-send-close").click();await page.waitForFunction(()=>document.getElementById("wallet-send-password").value==="");assert.equal(await page.locator("#wallet-send-password").inputValue(),"");assert.equal(await page.locator("#wallet-send-amount").inputValue(),"");
 await page.locator("#wallet-open-send").click();await page.keyboard.press("Escape");await page.locator("#wallet-send-panel").waitFor({state:"hidden"});
 report.checks.push("Themed modal, exact KOIN/VHP maxima, mana limit, token-change reset, X/Escape closure and password clearing");
 await page.locator('[data-page="earning"]').click();assert.equal(await page.locator("#earn-legacy-status").innerText(),"Drop Date: Nov 15, 2026");assert.equal(await page.locator("#reward-today-detail,#reward-pending-detail").count(),0);assert.match(await page.locator(".product-reward-summary").innerText(),/Daily Estimated Earnings/);
 report.checks.push("Reward date and compact labels render in Core");assert.deepEqual(errors,[]);report.status="passed";
 }catch(e){report.status="failed";report.error=e.stack;throw e;}finally{if(app)await app.close();fs.writeFileSync(path.join(output,"report.json"),JSON.stringify(report,null,2));fs.rmSync(temp,{recursive:true,force:true});}
 console.log(JSON.stringify(report));
}
module.exports={fixture};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
