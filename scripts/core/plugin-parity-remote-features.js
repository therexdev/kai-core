"use strict";
const assert=require("node:assert/strict");
async function remoteFeatures(win,h) {
  const {js,call,click}=h;
  assert.equal(await js(win,'document.querySelector("#optional-node-open,#optional-code-open,#optional-developer-open,#btn-koinos-toggle,#btn-dev-toggle,#btn-code-toggle,#optional-notice")'),null,"Remote Access must not expose other app controls");
  await assert.rejects(call(win,"remote.features",{action:"status"}),/permission denied/i);
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
  return "Offline localization preserves API data; optional app controls and cross-app capability are absent";
}
module.exports={remoteFeatures};
