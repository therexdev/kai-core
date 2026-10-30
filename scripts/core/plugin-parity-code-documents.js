"use strict";
// Integration scenarios for the original Code/Documents UI against the real
// scoped brokers and original engines in the all-plugin synthetic fixture.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
async function code(win,h){
 const {js,call,click,fill,until,capture,output,features,fixture}=h;
 await until(win,'document.getElementById("kc-gh-status").textContent.length>0',"Code workspace did not initialize");
 for(const id of ["kc-projects","kc-sessions","btn-kc-clone","btn-kc-gh","btn-kc-commit","btn-kc-push","btn-kc-pr","kc-plan","kc-model","kc-tools-list"])assert.ok(await js(win,`!!document.getElementById(${JSON.stringify(id)})`),id);
 fixture.openDialogResponses.push({canceled:false,filePaths:[fixture.projectDir]});
 await click(win,"#btn-kc-pick");await until(win,'!document.getElementById("kc-chat").hidden',"Original native project selection did not open Code");
 await click(win,"#btn-kc-new");await until(win,'document.getElementById("kc-sessions").children.length>0',"Original project conversation was not created");
 const selected=(await call(win,"code.request",{path:"/core/code/projects",method:"GET"})).body.projects.find(p=>p.path===fixture.projectDir);assert.ok(selected);
 await fill(win,{"kc-task":"Say parity ready. Do not write files or run commands."});
 await click(win,"#btn-kc-run");await until(win,'document.getElementById("kc-status").textContent.startsWith("done")',"Original CodeAgent did not complete over the stream bridge");
 const sessions=(await call(win,"code.request",{path:`/core/code/projects/${selected.id}/sessions`,method:"GET"})).body.sessions;assert.ok(sessions.length);
 const saved=(await call(win,"code.request",{path:`/core/code/projects/${selected.id}/sessions/${sessions[0].id}`,method:"GET"})).body.session;assert.ok(saved.turns.some(turn=>turn.role==="user"));assert.ok(saved.turns.some(turn=>turn.role==="assistant"));
 await click(win,"#btn-kc-tools");await until(win,'!document.getElementById("kc-tools-panel").hidden',"Original project tools picker did not open");
 await capture(win,path.join(output,"code-full-workspace.png"));await click(win,"#btn-kc-tools-close");
 assert.ok(!fixture.externalCalls?.length,"Code attempted an external request");
 return "Original native folder selection, project/conversation creation, real CodeAgent streaming run, persisted transcript, model/tool controls";
}
async function documents(win,h){
 const {js,call,click,fill,until,capture,output}=h;
 await until(win,'document.getElementById("doc-model").options.length>0',"Original Documents editor did not initialize");
 for(const action of ["improve","grammar","shorten","expand","continue"])assert.ok(await js(win,`!!document.querySelector('[data-act="${action}"]')`));
 await fill(win,{"doc-title":"Original writing workspace","doc-body":"First draft words"});await until(win,'document.getElementById("doc-saved").textContent.includes("Saved")',"Original Documents autosave did not save");
 const listed=await call(win,"documents.list");const entry=listed.documents.find(row=>row.title==="Original writing workspace");assert.ok(entry);const before=await call(win,"documents.get",{id:entry.id});assert.equal(before.content,"First draft words");
 await js(win,'document.getElementById("doc-body").focus();document.getElementById("doc-body").setSelectionRange(0,5);void 0');await click(win,'[data-act="grammar"]');
 await until(win,'!document.getElementById("doc-apply").disabled && document.getElementById("doc-suggest-body").textContent.length>0',"Selection-aware Documents suggestion did not stream");
 const proposal=await js(win,'document.getElementById("doc-suggest-body").textContent');assert.ok(proposal);
 assert.equal((await call(win,"documents.get",{id:entry.id})).content,"First draft words","AI suggestion was saved before Apply");await click(win,"#doc-apply");await until(win,'document.getElementById("doc-saved").textContent.includes("Saved")',"Applied writing was not autosaved");assert.equal((await call(win,"documents.get",{id:entry.id})).content,proposal+" draft words");
 await click(win,'[data-act="shorten"]');await until(win,'!document.getElementById("doc-apply").disabled',"Second writing suggestion did not arrive");
 await fill(win,{"doc-body":proposal+" draft words with a newer edit"});assert.equal(await js(win,'document.getElementById("doc-apply").disabled'),true);await until(win,'document.getElementById("doc-saved").textContent.includes("Saved")',"Latest writing edit was not saved");
 await capture(win,path.join(output,"documents-full-workspace.png"));await click(win,"#doc-discard");
 await click(win,"#btn-new-doc");await until(win,'document.getElementById("doc-body").value===""',"New document did not clear editor");
 await click(win,`.doc-row[data-id="${entry.id}"]`);await until(win,'document.getElementById("doc-body").value.includes("newer edit")',"Saved original document did not reopen");
 return "Original document rail/editor, autosave, selection-aware streamed AI, explicit Apply, stale suggestion rejection, saved-document reopen";
}
module.exports={code,documents};
