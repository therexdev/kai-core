"use strict";
const assert=require("node:assert/strict"),path=require("node:path");
async function remoteFeatures(win,h) {
  const {js,call,click,until,features,fixture,capture,output}=h;
  await until(win,'document.getElementById("optional-code-status").textContent.length>0',"Original optional-feature rows did not load");
  await js(win,"window.kaiLanguageReady");
  const languageBefore=await js(win,"KaiI18n.language"),dataBefore=await js(win,'["api-snippet","new-key-value","remote-base"].map(id=>document.getElementById(id).textContent)');
  try {
    await js(win,'KaiI18n.setLanguage("es");void 0');
    assert.equal(await js(win,'document.querySelector("#view-api h1").textContent'),await js(win,'KaiI18n.t("Your local OpenAI-compatible API")'));
    assert.equal(await js(win,'document.getElementById("btn-new-key").textContent'),"Crear clave");
    await click(win,"#key-list .linklike");
    assert.equal(await js(win,'document.querySelector(".budget-edit .primary").textContent'),await js(win,'KaiI18n.t("Save")'));
    assert.equal(await js(win,'document.querySelector(".budget-edit button:last-child").textContent'),await js(win,'KaiI18n.t("Cancel")'));
    assert.deepEqual(await js(win,'["api-snippet","new-key-value","remote-base"].map(id=>document.getElementById(id).textContent)'),dataBefore,"Language changes must preserve API keys, endpoints and model aliases");
    await click(win,".budget-edit button:last-child");
  } finally {await js(win,'KaiI18n.setLanguage('+JSON.stringify(languageBefore)+');void 0');}
  const initial=await call(win,"remote.features",{action:"status"}),previous=features.ctx.confirm;
  features.ctx.confirm=async title=>{fixture.nativeActions.push("optional-feature-review:"+title);return true;};
  try {
    for(const [name,button] of [["code","btn-code-toggle"],["developer","btn-dev-toggle"]]) {
      const row=initial.features.find(value=>value.name===name);assert.ok(row);
      if(!row.available) {const before=fixture.nativeActions.length;await click(win,"#"+button);await until(win,'!document.getElementById('+JSON.stringify(button)+').disabled',"Missing plugin handoff did not finish");assert.ok(fixture.nativeActions.slice(before).includes("core-view:plugins"));continue;}
      await call(win,"remote.features",{action:"toggle",feature:name,enabled:false});
      await js(win,'window.dispatchEvent(new Event("focus"));void 0');await until(win,'document.getElementById('+JSON.stringify(button)+').getAttribute("aria-checked")==="false"',"Disabled workspace was not reflected in original switch");
      await click(win,"#"+button);await until(win,'document.getElementById('+JSON.stringify(button)+').getAttribute("aria-checked")==="true"',"Visible native-reviewed switch did not reenable workspace");
      assert.equal((await call(win,"remote.features",{action:"status"})).features.find(value=>value.name===name).enabled,true);
      await click(win,"#optional-"+name+"-open");await until(win,'!document.getElementById('+JSON.stringify(button)+').disabled',"Open workspace handoff did not finish");assert.ok(fixture.nativeActions.includes("core-view:"+(name==="code"?"code":"devtools")));
    }
    await click(win,"#btn-koinos-toggle");await until(win,'!document.getElementById("btn-koinos-toggle").disabled',"Node plugin management handoff did not finish");assert.ok(fixture.nativeActions.includes("core-view:plugins"));
    await js(win,'document.getElementById("btn-code-toggle").scrollIntoView({block:"end"});void 0');await capture(win,path.join(output,"kai.remote-access.optional-workspaces.png"));
  } finally {features.ctx.confirm=previous;}
  return "Original offline localization preserves API data; Node/Developer/Code optional rows, disabled-to-enabled native switches, separate workspace links and Plugins handoff";
}
module.exports={remoteFeatures};
