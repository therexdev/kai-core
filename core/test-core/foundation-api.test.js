"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { EventEmitter } = require("node:events"), { Writable, Readable } = require("node:stream");
const { createFoundationApi } = require("../../electron/foundation-api");
const { requestChunks, boundedResponse, pinnedRequest, checkedHeaders } = require("../../electron/foundation-network");
const { PERMISSIONS } = require("../lib/plugins/package");
function fixture(t, { id="community.test", fingerprint="a".repeat(64), permissions=PERMISSIONS, directory }={}) {
  const dir=directory||fs.mkdtempSync(path.join(os.tmpdir(),"kai-foundation-api-"));if(!directory)t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const controller=new AbortController(), tracked=new Set(), calls=[], window=new EventEmitter();
  Object.assign(window,{id:101,isDestroyed:()=>false,isVisible:()=>true,isMinimized:()=>false});
  const wc={id:202,mainFrame:{url:`kai-plugin://${id}/index.html`},isDestroyed:()=>false,send:(...args)=>calls.push(["event",...args])};
  let privacy="local-only", token="private-token", visible=true;
  const context={
    core:{gateway:{port:41100,coreToken:"core-only-secret",network:{status:()=>({privacyMode:privacy}),trackShadowRequest:c=>{tracked.add(c);return()=>tracked.delete(c);}}},
      models:{aliases:()=>[{alias:"local-model",label:"Local",status:"ready"}]},runtime:{status:()=>({running:false}),ensure:async alias=>({alias})},settings:{get:(_key,fallback)=>fallback,set:()=>{}},account:{origin:()=>"https://account.example",_token:()=>token}},
    electron:{dialog:{showMessageBox:async()=>({response:1})},shell:{openExternal:async url=>calls.push(["external",url])},safeStorage:{isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=>"test",encryptString:text=>Buffer.from(text),decryptString:buf=>buf.toString()}},
    getWindow:()=>window,getWebContents:()=>wc,isVisible:()=>visible,isClosing:()=>false,
    openPlugin:async(...args)=>calls.push(["plugin",...args]),openCoreView:async(...args)=>calls.push(["core",...args]),setPrivacyMode:async mode=>{privacy=mode;return {privacyMode:mode};},
    payments:()=>({runForPlugin:async(action,input,options)=>{calls.push(["payment",action,input,options]);return{completion:{choices:[{message:{content:"reply"}}]},models:[]};}}),wallet:()=>({call:async()=>({address:"public-address"})}),
  };
  const record={manifest:{id,version:"1.0.0",name:"Community Test",entry:"index.html",permissions},fingerprint,root:"/signed/code",dataDir:dir,controller};
  return {api:createFoundationApi(context,record),context,record,controller,calls,window,wc,tracked,setPrivacy(mode){privacy=mode;if(mode==="local-only")for(const c of tracked)c.abort(Error("Local-Only"));},setToken(value){token=value;},setVisible(value){visible=value;}};
}
function mockFetch(t, implementation){const previous=global.fetch;global.fetch=implementation;t.after(()=>{global.fetch=previous;});}

test("public native API has no raw Core object and checks each capability",t=>{
  const {api}=fixture(t,{permissions:[]});assert.equal(api.core,undefined);assert.equal(api.gateway,undefined);assert.equal(api.accountToken,undefined);
  assert.throws(()=>api.models.list(),/models.read/);assert.throws(()=>api.settings.get("key"),/storage.read/);assert.throws(()=>api.desktop.hostWindowId(),/desktop.windows/);assert.throws(()=>api.wallet.summary(),/wallet.read/);assert.throws(()=>api.secrets.encryptString("secret"),/secrets.use/);
});
test("settings are scoped, copied and reject prototype paths",t=>{
  const a=fixture(t),b=fixture(t,{id:"community.other"});const value={items:[1]};a.api.settings.set("prefs.list",value);value.items.push(2);
  assert.deepEqual(a.api.settings.get("prefs.list"),{items:[1]});assert.equal(b.api.settings.get("prefs.list","missing"),"missing");
  assert.throws(()=>a.api.settings.set("__proto__.polluted",true),/Invalid preference/);assert.equal({}.polluted,undefined);
  const c=fixture(t,{directory:a.record.dataDir});assert.deepEqual(c.api.settings.get("prefs.list"),{items:[1]});
});
test("corrupt preferences are preserved and not silently replaced",t=>{
  const a=fixture(t),file=path.join(a.record.dataDir,"preferences.json");fs.writeFileSync(file,"not json");assert.throws(()=>fixture(t,{directory:a.record.dataDir}));assert.equal(fs.readFileSync(file,"utf8"),"not json");
});
test("revoked API rejects calls before any network or desktop action",async t=>{
  const f=fixture(t);let requests=0;mockFetch(t,async()=>{requests++;throw Error("unexpected")});f.controller.abort(Error("Plugin stopped"));
  assert.throws(()=>f.api.models.list(),/Plugin stopped/);await assert.rejects(f.api.models.chat({model:"local-model",messages:[]}),/Plugin stopped/);await assert.rejects(f.api.desktop.openExternal("https://example.org"),/Plugin stopped/);assert.equal(requests,0);
});
test("local inference cannot select a private provider and forces private local routing",async t=>{
  const f=fixture(t);let called;
  mockFetch(t,async(url,options)=>{called={url,options};return new Response(JSON.stringify({choices:[{message:{content:"local"}}]}),{headers:{"content-type":"application/json"}})});
  await assert.rejects(f.api.models.chat({model:"desktop:private-provider",messages:[]}),/installed local model/);
  const result=await f.api.models.chat({model:"local-model",messages:[{role:"user",content:"Hi"}],kai_private_desktop:false});
  assert.equal(result.choices[0].message.content,"local");assert.equal(JSON.parse(called.options.body).kai_private_desktop,true);assert.equal(called.options.headers.authorization,"Bearer core-only-secret");
});
test("network inference requires spending capability and carries plugin identity to payment scope",async t=>{
  const f=fixture(t);await f.api.models.chat({model:"koinos-network:test",messages:[]});const call=f.calls.find(c=>c[0]==="payment");assert.equal(call[3].pluginId,"community.test");assert.equal(call[3].fingerprint,"a".repeat(64));
  const denied=fixture(t,{permissions:["inference.network"]});await assert.rejects(denied.api.models.chat({model:"koinos-network:test",messages:[]}),/wallet.authorize/);
});
test("native approvals require this exact visible plugin document before and after review",async t=>{
  const f=fixture(t);f.setVisible(false);assert.equal(await f.api.desktop.confirm("Do work?","Bounded details"),false);f.setVisible(true);
  f.context.electron.dialog.showMessageBox=async()=>{f.wc.mainFrame={url:"kai-plugin://community.other/index.html"};return{response:1};};
  assert.equal(await f.api.desktop.confirm("Do work?","Bounded details"),false);
  f.wc.mainFrame={url:"kai-plugin://community.test/index.html"};await assert.rejects(f.api.desktop.confirm("Do work?","x".repeat(16001)),/too long/);
});
test("external URLs and account paths cannot bypass destination validation",async t=>{
  const f=fixture(t);for(const url of ["file:///tmp/local","http://example.org","https://user:secret@example.org"])await assert.rejects(f.api.desktop.openExternal(url),/HTTPS/);
  f.setPrivacy("network");for(const url of ["https://evil.test/","//evil.test/","/\\evil.test/"])await assert.rejects(f.api.account.request(url),/path/);
});
test("native review cannot approve after its originating view was hidden and reopened",async t=>{
  const f=fixture(t), lifecycle=new AbortController(); f.context.getDialogSignal=()=>lifecycle.signal;
  f.context.electron.dialog.showMessageBox=async(_window,options)=>{assert.equal(options.signal.aborted,false);lifecycle.abort();return{response:1};};
  assert.equal(await f.api.desktop.confirm("Do work?","Bounded details"),false);
});
test("account requests keep credentials in headers and abort when Local-Only returns",async t=>{
  const f=fixture(t);f.setPrivacy("network");let seen;
  mockFetch(t,async(url,options)=>{seen={url,options};return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("hello"));}}));});
  const response=await f.api.account.request("/profile");assert.equal(seen.options.headers.authorization,"Bearer private-token");assert.equal(f.api.account.status().token,undefined);assert.equal(f.tracked.size,1);
  f.setPrivacy("local-only");await assert.rejects(response.text(),/Local-Only/);assert.equal(f.tracked.size,0);
});
test("account response is revoked if the signed-in identity changes",async t=>{
  const f=fixture(t);f.setPrivacy("network");mockFetch(t,async()=>{f.setToken("replacement-token");return new Response("private reply")});
  await assert.rejects(f.api.account.request("/profile"),/account changed/);assert.equal(f.tracked.size,0);
});
test("public fetch fails closed in Local-Only and rejects private IP targets",async t=>{
  const f=fixture(t);await assert.rejects(f.api.network.fetch("https://example.org"),/Local-Only/);f.setPrivacy("network");await assert.rejects(f.api.network.fetch("https://127.0.0.1/private"),/public|private|blocked|local/i);assert.equal(f.tracked.size,0);
});
test("stream uploads preserve chunks and enforce a cumulative size limit",async()=>{
  const signal=new AbortController().signal;const chunks=[];for await(const chunk of requestChunks(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));c.enqueue(new Uint8Array([3]));c.close();}}),signal))chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from([1,2,3]));await assert.rejects(async()=>{for await(const _ of requestChunks([].values(),signal)){}},/body must/);
  await assert.rejects(async()=>{for await(const _ of requestChunks((async function*(){yield Buffer.alloc(3);yield Buffer.alloc(3);})(),signal,4)){}},/exceeds/);
});
test("network response bounds release its privacy tracker exactly once",async()=>{
  let releases=0;const controller=new AbortController();const response=boundedResponse(new Response("too long"),{signal:controller.signal,limit:3,release:()=>releases++});
  await assert.rejects(response.text(),/byte limit/);controller.abort();assert.equal(releases,1);assert.throws(()=>checkedHeaders({host:"private.internal"}),/cannot set host/);
});
test("streamed public requests pin DNS and retain SSE response streaming",async()=>{
  let lookupResult,uploaded=Buffer.alloc(0),receivedOptions;
  const requestImpl=(_url,options,onResponse)=>{receivedOptions=options;options.lookup("public.example",{all:false},(_error,address,family)=>{lookupResult={address,family};});
    const request=new Writable({write(chunk,_encoding,done){uploaded=Buffer.concat([uploaded,chunk]);done();},final(done){const response=Readable.from([Buffer.from("data: one\\n\\n"),Buffer.from("data: two\\n\\n")]);response.statusCode=200;response.headers={"content-type":"text/event-stream"};onResponse(response);done();}});return request;};
  const response=await pinnedRequest(new URL("https://public.example/stream"),{addresses:[{address:"8.8.8.8",family:4}],method:"POST",body:(async function*(){yield "one";yield "two";})(),signal:new AbortController().signal,requestImpl});
  assert.deepEqual(lookupResult,{address:"8.8.8.8",family:4});assert.equal(receivedOptions.agent,false);assert.equal(uploaded.toString(),"onetwo");assert.equal(await new Response(response.body).text(),"data: one\\n\\ndata: two\\n\\n");
});

test("declared local RPC can review for its visible initiator without giving background work authority",async t=>{
  const f=fixture(t,{id:"community.provider"}), initiatorController=new AbortController();
  const initiatingContents={id:999,mainFrame:{url:"kai-plugin://community.consumer/index.html"},isDestroyed:()=>false};
  f.record.invocation=()=>({id:"community.consumer",name:"Consumer",webContents:initiatingContents,frame:initiatingContents.mainFrame,entry:initiatingContents.mainFrame.url,signal:initiatorController.signal});
  f.context.getWebContents=id=>id==="community.consumer"?initiatingContents:f.wc;f.context.isVisible=id=>id==="community.consumer";
  let detail;f.context.electron.dialog.showMessageBox=async(_w,options)=>{detail=options.detail;return{response:1};};
  assert.equal(await f.api.desktop.confirm("Approve action?","Exact action"),true);assert.match(detail,/Requested by Consumer/);
  initiatorController.abort();assert.equal(await f.api.desktop.confirm("Approve action?","Exact action"),false);
  f.record.invocation=()=>null;assert.equal(await f.api.desktop.confirm("Approve action?","Exact action"),false);
});

test("embeddings use only a validated installed model and the private authenticated route",async t=>{
  const f=fixture(t);let called;mockFetch(t,async(url,options)=>{called={url,options};return Response.json({data:[{embedding:[0.1,0.2]}]});});
  await assert.rejects(f.api.models.embeddings({model:"koinos-network",input:"text"}),/local embedding model/);
  const result=await f.api.models.embeddings({model:"local-model",input:"text"});assert.deepEqual(result.data[0].embedding,[0.1,0.2]);assert.match(called.url,/\/core\/embeddings$/);assert.equal(called.options.headers.authorization,"Bearer core-only-secret");
});
