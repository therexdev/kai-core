"use strict";
const assert=require("node:assert/strict"),path=require("node:path");
async function toolsDeveloper(win,h) {
  const {js,call,click,fill,until,capture,output,features}=h;
  const fetchRoute=async(path,method="GET",body)=>call(win,"tools.ui.request",{path,method,body,requestId:require("node:crypto").randomUUID()});
  await until(win,'document.getElementById("btn-dev-toggle").getAttribute("aria-checked")==="false"',"Developer switch did not preserve original disabled state");
  const oldConfirm=features.ctx.confirm;features.ctx.confirm=async()=>true;
  try {
    await click(win,"#btn-dev-toggle");
    await until(win,'!document.getElementById("view-devtools").hidden && document.querySelectorAll("#ag-list .agent-card").length===2',"Original developer view did not open");
    const spec={label:"Synthetic human review",mode:"round_robin",agents:[{name:"Human",human:true},{name:"Writer",systemPrompt:"Return a short answer."}],termination:{maxMessages:2,maxModelCalls:2}};
    await fill(win,{"ag-json":JSON.stringify(spec)});await click(win,"#btn-ag-save");
    await until(win,'document.querySelector("#ag-defs option")?.value.length>0',"Original saved team was not created");
    const saved=(await fetchRoute("/core/agents/defs")).body.defs.find(row=>row.label===spec.label);assert.ok(saved);assert.equal(saved.spec.agents[0].human,true);
    await click(win,'#devtools-tabs [data-tab="playground"]');await fill(win,{"pg-task":"Respond after the human message."});await click(win,"#btn-pg-run");
    await until(win,'!document.getElementById("pg-input-row").hidden',"Original group runner did not request human input");
    await fill(win,{"pg-input":"Synthetic reviewed input"});await click(win,"#btn-pg-send");
    await until(win,'document.getElementById("pg-status").textContent.startsWith("ended:")',"Original group runner did not finish after input");
    assert.match(await js(win,'document.getElementById("pg-convo").textContent'),/Synthetic reviewed input/);
    await click(win,"#btn-pg-run");await until(win,'!document.getElementById("pg-input-row").hidden',"Second run did not wait for human");await click(win,"#btn-pg-stop");await until(win,'document.getElementById("btn-pg-stop").hidden',"Original group stop did not finish");
    await click(win,'#devtools-tabs [data-tab="pipelines"]');await fill(win,{"dev-spec":JSON.stringify({label:"Synthetic pipeline",stages:["write"],tools:[],maxModelCalls:2}),"dev-question":"Give one short answer"});await click(win,"#btn-dev-run");await until(win,'document.getElementById("dev-team-out").textContent.includes("=== answer")',"Original pipeline did not stream its answer");
    await click(win,'#devtools-tabs [data-tab="bench"]');await click(win,"#btn-dev-bench");await until(win,'document.getElementById("dev-bench-out").textContent.includes("Score:")',"Original objective benchmark did not return its score");
    await capture(win,path.join(output,"tools-developer-benchmark.png"));
    await click(win,'#devtools-tabs [data-tab="agents"]');await click(win,"#btn-ag-del");await until(win,'document.querySelector("#ag-defs option")?.value===""',"Saved team was not deleted after native review");
    assert.equal((await fetchRoute("/core/agents/defs")).body.defs.some(row=>row.id===saved.id),false);
  } finally {features.ctx.confirm=oldConfirm;}
  return "Original developer switch, saved multi-agent teams, real human-input/stop streams, custom pipeline and objective benchmark";
}
module.exports={toolsDeveloper};
