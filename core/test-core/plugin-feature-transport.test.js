"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {createFeatureRequests}=require('../../electron/plugin-services/feature-requests');
const {create}=require('../../electron/plugin-services/model-compare');
const {createPluginDesktop}=require('../../electron/core-plugin-desktop');
test('feature request cancellation reaches an in-flight native request before a stream is created',async()=>{
 let started, observed; const ready=new Promise(resolve=>started=resolve);
 const api=createFeatureRequests({legacyRequest:async(feature,input,signal)=>{observed=signal;started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}},'model-compare');
 const pending=api.request({requestId:'cancel-before-stream',path:'/core/chat/completions'},new AbortController().signal);const rejected=assert.rejects(pending,/aborted/);await ready;
 await api.cancel({requestId:'cancel-before-stream'});await rejected;assert.equal(observed.aborted,true);await api.dispose();
});
test('comparison cannot use its request grant to access wallet, tools or coding routes',async()=>{
 let calls=0;const service=create({legacyRequest:async()=>{calls++;return {status:200,body:{}};}}), signal=new AbortController().signal;
 for(const path of ['/core/koinos/rpc','/core/tools/call','/core/code/run','https://example.invalid/core/models'])await assert.rejects(service.call('compare.request',{path,method:'POST',requestId:'x'},signal),/denied/);
 assert.equal(calls,0);await service.call('compare.request',{path:'/core/models',requestId:'ok'},signal);assert.equal(calls,1);await service.dispose();
});
test('feature streams cannot be polled or cancelled through another local request map',async()=>{
 const calls=[];const ctx={legacyRequest:async()=>({status:200,streamId:'owned'}),legacyPoll:async(feature,id)=>({chunks:['data'],done:true}),legacyCancel:async(feature,id)=>calls.push(id)};
 const one=createFeatureRequests(ctx,'model-compare'),two=createFeatureRequests(ctx,'tools');await one.request({requestId:'first'});
 await assert.rejects(two.poll({streamId:'owned'}),/Unknown/);await two.cancel({requestId:'first'});assert.deepEqual(calls,[]);
 assert.deepEqual(await one.poll({streamId:'owned'}),{chunks:['data'],done:true});await assert.rejects(one.poll({streamId:'owned'}),/Unknown/);await one.dispose();await two.dispose();
});
test('desktop navigation and original interface migration accept only enumerated views and non-secret keys',async()=>{
 const calls=[];const window={isDestroyed:()=>false,show(){},focus(){},webContents:{send:(...args)=>calls.push(args),executeJavaScript:async source=>{assert.ok(!source.includes('token'));return {'kai-compare-tally':'{}'};}}};
 const record={window,controller:new AbortController(),manifest:{id:'kai.model-compare',name:'Compare'}};
 const run=createPluginDesktop({electron:{shell:{openExternal:async()=>calls.push('external')}},getCoreWindow:()=>window,openPlugin:async id=>calls.push(id),confirm:async()=>false,isClosing:()=>false});
 await run(record,'desktop.openView',{view:'models'});assert.equal(calls[0][1],'models');
 await assert.rejects(run(record,'desktop.openView',{view:'http://evil'}),/Unknown/);
 await assert.rejects(run(record,'desktop.preferencesRead',{keys:['account-token']}),/Unsupported/);
 assert.deepEqual(await run(record,'desktop.preferencesRead',{keys:['kai-compare-tally']}),{'kai-compare-tally':'{}'});
 assert.deepEqual(await run(record,'desktop.openExternal',{url:'https://example.com/docs'}),{cancelled:true});assert.equal(calls.length,1);
});

test('original navigation preserves exact Node, Developer Tools and Local API destinations',async()=>{
 const {resolveView}=require('../../electron/core-plugin-desktop');
 for(const section of ['wallet','fund','burn','node','returns','settings'])assert.deepEqual(resolveView(`koinos-${section}`),{plugin:'kai.koinos-node',page:null,section});
 assert.deepEqual(resolveView('koinos','wallet'),{plugin:'kai.koinos-node',page:null,section:'wallet'});
 assert.deepEqual(resolveView('api'),{plugin:'kai.remote-access',page:null,section:undefined});
 assert.deepEqual(resolveView('devtools'),{plugin:'kai.tools',page:null,section:'devtools'});
 assert.equal(resolveView('tasks').plugin,'kai.workflows');
 assert.throws(()=>resolveView('docs','wallet'),/section/);
 assert.throws(()=>resolveView('koinos','__proto__'),/section/);
});
