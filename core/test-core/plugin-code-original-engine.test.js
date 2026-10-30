"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {createLegacyRuntime}=require("../../electron/plugin-services/legacy-runtime"),{create}=require("../../electron/plugin-services/code-workspace");
for(const approved of [false,true])test(`restored original CodeAgent ${approved?"applies":"refuses"} the exact native-reviewed file edit`,async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"kai-original-code-"))),dataDir=path.join(root,"profile","core"),projectDir=path.join(root,"project");fs.mkdirSync(dataDir,{recursive:true});fs.mkdirSync(projectDir);const file=path.join(projectDir,"hello.txt");fs.writeFileSync(file,"before\n");fs.writeFileSync(path.join(dataDir,"settings.json"),JSON.stringify({network:{privacyMode:"local-only"}}));
 const core=await require("../server").createCore({dataDir,extensions:false,onEvent(){}}),reviews=[];
 const confirm=async(title,detail)=>{reviews.push({title,detail});return title==="Approve coding action?"?approved:true;};
 core.models.aliases=()=>[{alias:"local",status:"ready"}];
 const runtime=createLegacyRuntime({dataDir,core,confirm}),ctx={dataDir,core,confirm,legacyEnsure:feature=>runtime.ensure(feature),legacyRequest:(feature,input,signal)=>runtime.request(feature,input,signal),legacyPoll:(feature,id,signal)=>runtime.poll(feature,id,signal),legacyCancel:(feature,id)=>runtime.cancel(feature,id),legacyRelease:feature=>runtime.release(feature)};
 const service=create(ctx),originalFetch=global.fetch;let requests=0;
 global.fetch=async(url,options)=>{assert.match(String(url),/^http:\/\/127\.0\.0\.1:\d+\/core\/chat\/completions$/);requests++;const body=JSON.parse(options.body);assert.equal(body.stream,false);assert.equal(body.kai_private_desktop,true);const content=requests===1?JSON.stringify({tool:"write_file",args:{path:"hello.txt",content:"after\n"}}):approved?"The approved edit is complete.":"The edit was declined.";return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{"content-type":"application/json"}});};
 t.after(async()=>{global.fetch=originalFetch;await service.dispose();await runtime.dispose();await core.stop();fs.rmSync(root,{force:true,recursive:true});});
 const added=await service.call("code.request",{path:"/core/code/projects",method:"POST",body:{dir:projectDir,name:"Saved original project"}});assert.equal(added.body.ok,true);
 const started=await service.call("code.request",{path:"/core/code/run",method:"POST",body:{projectId:added.body.project.id,task:"Change hello.txt to after",model:"local",maxSteps:3}});assert.ok(started.streamId);
 let pending,done=false,events=[];const deadline=Date.now()+5000;
 async function poll(){const result=await service.call("code.poll",{streamId:started.streamId});for(const chunk of result.chunks)for(const line of chunk.split("\n"))if(line.startsWith("data: ")){const event=JSON.parse(line.slice(6));events.push(event);if(event.trace?.type==="approval-request")pending=event.trace;}done=result.done;}
 while(!pending&&!done&&Date.now()<deadline){await poll();await new Promise(resolve=>setImmediate(resolve));}
 assert.ok(pending,"Original coding engine did not propose its file edit: "+JSON.stringify(events));assert.equal(fs.readFileSync(file,"utf8"),"before\n");
 const request={path:"/core/code/approve",method:"POST",body:{approvalId:pending.approvalId,approved:true,detail:"Forged unrelated review"}};
 if(approved)await service.call("code.request",request);else{await assert.rejects(service.call("code.request",request),/not approved/);await service.call("code.request",{...request,body:{approvalId:pending.approvalId,approved:false}});}
 while(!done&&Date.now()<deadline){await poll();await new Promise(resolve=>setImmediate(resolve));}
 assert.ok(done,"Original coding run did not finish");assert.equal(fs.readFileSync(file,"utf8"),approved?"after\n":"before\n");const review=reviews.find(r=>r.title==="Approve coding action?");assert.ok(review);assert.match(review.detail,/hello\.txt/);assert.match(review.detail,/after/);assert.doesNotMatch(review.detail,/Forged unrelated/);
 const stored=JSON.parse(fs.readFileSync(path.join(dataDir,"code-projects.json"),"utf8"));assert.equal(stored[0].sessions[0].turns.length,2);
});
