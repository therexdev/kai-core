"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
async function assistant(win, h) {
  const { js, call, click, fill, submit, until, capture, output } = h;
  await until(win, "document.getElementById('model-pick').options.length > 0", "Original Assistant model picker");
  if (await js(win, "document.getElementById('language-dialog').open")) { await fill(win, { "first-language": "en" }); await click(win, "#language-continue"); }
  await until(win, "document.getElementById('chat-list').innerText.includes('Earlier synthetic chat')", "Original Assistant chat history");
  assert.equal(await js(win, "document.getElementById('mode-pick').options.length"), 6);
  assert.equal(await js(win, "document.getElementById('persona-pick').options.length"), 5);
  await click(win, "#btn-new-chat");
  await fill(win, { "persona-pick": "custom", "persona-custom": "Explain this synthetic test clearly.", input: "Synthetic smoke request" });
  await js(win, "setAttachment('synthetic.txt','Preserved attachment context.');void 0");
  await submit(win, "#composer");
  await until(win, "document.getElementById('messages').innerText.includes('Synthetic local response') && !state.chatting", "Original Assistant answer");
  const saved = (await call(win, "assistant.request", { path: "/core/chats" })).body.chats;
  assert.equal(saved.length, 2);
  const chat = (await call(win, "assistant.request", { path: "/core/chats/" + saved.find(c => c.id !== "synthetic-legacy-chat").id })).body.chat;
  assert.ok(chat.messages.some(m => m.content.includes("Preserved attachment context.")));
  assert.equal(chat.system, "Explain this synthetic test clearly.");
  assert.ok(await js(win, "!!document.querySelector('[data-act=regen]') && !!document.querySelector('[data-act=remember]') && !!document.querySelector('[data-act=copy]')"));
  await click(win, "[data-act=copy]");
  await until(win, "document.querySelector('[data-act=copy]').innerText==='Copied'", "Original reply copy action");
  await capture(win, path.join(output, "kai.assistant.original-chat.png"));
  await click(win, "[data-view=settings]");
  await until(win, "!document.getElementById('desktop-providers').hidden", "Original provider settings");
  assert.equal(await js(win, "document.querySelectorAll('.provider-card').length"), 2);
  for (const asset of ["/kai-robot.svg", "/brand-mark.svg"]) {
    const mounted = h.core.gateway.staticAssets.get(asset); assert.ok(mounted, "Original companion asset mount " + asset);
    assert.match(require("node:fs").readFileSync(mounted, "utf8"), /<svg\b/);
  }
  const liveAssets = h.fixture.fromCore("core/lib/live-senses-assets").liveSensesAssets(); assert.equal(liveAssets.size, 6, "Original local voice activity assets must be packaged");
  for (const [route, file] of liveAssets) {
    assert.equal(h.core.gateway.staticAssets.get(route), file, "Original voice asset mount " + route);
    assert.ok(require("node:fs").statSync(file).size > 0, "Nonempty voice asset " + route);
    if (h.fixture.packagedCore) {
      const allowed = route.includes("/ort") ? [h.fixture.coreRoot + path.sep, h.fixture.coreRoot + ".unpacked" + path.sep] : [path.join(h.fixture.resourcesPath, "live-senses", "vad") + path.sep];
      assert.ok(allowed.some(root => path.resolve(file).startsWith(root)), "Voice asset must come from the installed package: " + route);
    }
  }
  await capture(win, path.join(output, "kai.assistant.original-providers.png"));
  await js(win, "window.kaiAssistantPreferencesReady");
  await click(win, "[data-view=chat]");
  await fill(win, { "mode-pick": "research" });
  await until(win, "window.kai.call('storage.get',{key:'original-ui-preferences'}).then(p=>p?.['kai-chat-mode']==='research')", "Persistent original Assistant preferences");
  assert.equal(require("electron").app.commandLine.hasSwitch("use-fake-device-for-media-stream"), true, "Media smoke must use Chromium synthetic devices only");
  const { fixture } = h;
  const audio = "(async()=>{try{const s=await navigator.mediaDevices.getUserMedia({audio:true});const count=s.getAudioTracks().length;s.getTracks().forEach(t=>t.stop());return {allowed:true,count};}catch(e){return {allowed:false,name:e.name};}})()";
  fixture.messageBoxResponses.push({ response: 0 });
  assert.equal((await js(win, audio)).allowed, false, "Unapproved microphone access must be denied");
  fixture.messageBoxResponses.push({ response: 1 });
  const granted = await js(win, audio); assert.equal(granted.allowed, true); assert.equal(granted.count, 1);
  const prompts = fixture.nativeActions.filter(action => action.startsWith("native-review:KAI Assistant media access:")).length;
  assert.equal((await js(win, audio)).allowed, true, "Reviewed audio grant remains usable in this window");
  assert.equal(fixture.nativeActions.filter(action => action.startsWith("native-review:KAI Assistant media access:")).length, prompts, "Existing grant should not ask for native approval again");
  assert.equal(await js(win, "navigator.permissions.query({name:'microphone'}).then(value=>value.state)"), "granted", "Permission queries reflect the reviewed audio grant");
  const framed = await js(win, "(async()=>{const f=document.createElement('iframe');document.body.appendChild(f);try{const s=await f.contentWindow.navigator.mediaDevices.getUserMedia({audio:true});s.getTracks().forEach(t=>t.stop());return {allowed:true};}catch(e){return {allowed:false,name:e.name};}finally{f.remove();}})()");
  assert.equal(framed.allowed, false, "A child frame cannot inherit the top-level microphone grant");
  assert.ok(fixture.mediaPermissionRequests.some(item => item.isMainFrame === true && item.requestingUrl === "kai-plugin://kai.assistant/index.html" && item.mediaTypes.includes("audio") && item.allowed === true));
  assert.ok(fixture.mediaPermissionChecks.some(item => item.isMainFrame === true && item.requestingUrl === "kai-plugin://kai.assistant/index.html" && item.mediaType === "audio" && item.allowed === true));
  await fill(win, { "src-pick": "local" });
  await until(win, "[...document.getElementById('model-pick').options].some(option=>option.value==='synthetic-a')", "Local companion launch model");
  await fill(win, { "model-pick": "synthetic-a" });
  await click(win, "#launch-kai");
  await until(win, "!document.getElementById('launch-kai').disabled", "Assistant launch button completes");
  assert.equal(await js(win, "document.getElementById('kai-launch-error').hidden"), true, "The real Assistant launcher must succeed");
  const mascot = require("electron").BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === `http://127.0.0.1:${h.core.gateway.port}/mascot.html`);
  assert.ok(mascot, "Original dedicated companion window opens");
  assert.equal(await js(mascot, "performance.getEntriesByType('resource').some(entry=>entry.initiatorType==='script' && new URL(entry.name).pathname==='/mascot.js')"), true, "Companion HTML must request its runtime script");
  const runtimeAsset = await js(mascot, "fetch('/mascot.js').then(async response=>({status:response.status,bytes:(await response.arrayBuffer()).byteLength}))");
  assert.equal(runtimeAsset.status, 200, "Companion runtime must be served with the production Core UI directory");
  assert.ok(runtimeAsset.bytes > 0, "Companion runtime must not be empty");
  await until(mascot, "!!document.querySelector('#kai-art svg')", "Original companion artwork");
  await until(mascot, "typeof document.getElementById('mascot-menu-button').onclick==='function' && [...document.getElementById('model').options].some(option=>option.value==='synthetic-a')", "Original companion initializes interactive controls and models");
  await click(mascot, "#mascot-menu-button");
  assert.equal(await js(mascot, "document.getElementById('mascot-menu').hidden"), false, "Companion menu responds after launch");
  await click(mascot, "#mascot-menu-button");
  assert.equal(await js(mascot, "document.getElementById('mascot-menu').hidden"), true);
  const servedAssets = await js(mascot, `Promise.all(${JSON.stringify([...liveAssets.keys()])}.map(async route=>{const r=await fetch(route);return {route,status:r.status,bytes:(await r.arrayBuffer()).byteLength};}))`);
  for (const asset of servedAssets) { assert.equal(asset.status, 200, asset.route); assert.ok(asset.bytes > 0, asset.route); }
  assert.equal(await js(mascot, "typeof require"), "undefined");
  assert.equal(await js(mascot, "typeof window.kaiDesktop.eyesEnable"), "function");
  assert.equal(await js(mascot, "typeof window.kaiDesktop.pocketSpeech"), "function");
  await until(mascot, "window.kaiDesktop.pocketStatus().then(value=>!value.supported || value.available || value.setup?.state==='error')", "Original companion voice setup settles under Local-Only");
  const pocket = await js(mascot, "window.kaiDesktop.pocketStatus()");
  if (pocket.supported && !pocket.available) await until(mascot, "document.getElementById('pocket-card-copy').textContent.includes('Local-Only')", "Original companion reports the native download privacy gate");
  await click(mascot, "#later-pocket");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(await js(mascot, "document.getElementById('pocket-card').hidden"), true, "Original companion setup notice closes");
  await js(mascot, "Promise.all([...new Set([...document.querySelectorAll('#kai-art image')].map(item=>item.getAttribute('href')))].map(src=>{const image=new Image();image.src=src;return image.decode();}))");
  const bounds = mascot.getBounds(); assert.ok(bounds.width >= 200 && bounds.height >= 200, "Original compact companion bounds: " + JSON.stringify({ bounds, display: require("electron").screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea }));
  const freshPaint = process.platform === "linux" && !process.env.DISPLAY ? new Promise((resolve, reject) => {
    const onPaint = (_event, _dirty, image) => { clearTimeout(timeout); resolve(image); };
    const timeout = setTimeout(() => { mascot.webContents.removeListener("paint", onPaint); reject(Error("Original companion did not paint its compact viewport")); }, 5000);
    mascot.webContents.once("paint", onPaint);
  }) : null;
  mascot.webContents.invalidate();
  const portrait = freshPaint ? await freshPaint : await mascot.webContents.capturePage(); assert.ok(portrait.getSize().width >= 200 && portrait.getSize().height >= 200, "Original companion screenshot matches its compact viewport");
  require("node:fs").writeFileSync(path.join(output, "kai.assistant.original-companion.png"), portrait.toPNG());
  fixture.messageBoxResponses.push({ response: 0 }); assert.equal((await js(mascot, audio)).allowed, false, "Companion audio requires its own native grant");
  fixture.messageBoxResponses.push({ response: 1 }); assert.equal((await js(mascot, audio)).allowed, true, "Original companion accepts reviewed synthetic audio");
  assert.equal(await js(mascot, "navigator.permissions.query({name:'microphone'}).then(value=>value.state)"), "granted");
  assert.equal((await js(mascot, "window.kaiDesktop.navigate('chat')")).ok, true, "Original companion returns to Assistant");
  return "Original Chat/Research/Agent/Teams controls, saved conversations, personas, attachment and streamed reply; provider settings, durable choices, reviewed synthetic audio and the original native companion window";
}
async function remote(win, h) {
  const { js, call, click, until, features } = h;
  await until(win, "document.getElementById('api-snippet').innerText.includes('from openai import OpenAI')", "Original local API example");
  const before = await call(win, "remote.api", { action: "status" });
  const confirm = features.ctx.confirm; features.ctx.confirm = async () => true;
  try {
    await click(win, "#btn-new-key");
    await until(win, "!document.getElementById('new-key-reveal').hidden", "Original one-time API key reveal");
    const after = await call(win, "remote.api", { action: "status" }); assert.equal(after.keys.length, before.keys.length + 1);
    const secret = await js(win, "document.getElementById('new-key-value').textContent"); assert.match(secret, /^kai_sk_/);
    assert.ok(!JSON.stringify(after).includes(secret)); assert.ok(!JSON.stringify(after).includes("digest"));
    await click(win, "#key-list .linklike");
    await js(win, "document.querySelector('.budget-edit input').value='2.5';document.querySelector('.budget-edit .primary').click();void 0");
    await until(win, "document.getElementById('key-list').innerText.includes('$2.5 budget')", "Original key budget editor");
  } finally { features.ctx.confirm = confirm; }
  await click(win, "#btn-remote-toggle");
  await until(win, "document.getElementById('remote-error').innerText.includes('Local-Only')", "Remote privacy gate");
  assert.equal((await call(win, "remote.api", { action: "status" })).remote.enabled, false);
  await click(win, "#remote-close"); assert.equal(await js(win, "document.getElementById('remote-notice').hidden"), true);
  return "Original local API endpoint, API-key creation/reveal, usage and monthly budget editor; original remote switch remains blocked in Local-Only";
}
module.exports = { assistant, remote };
