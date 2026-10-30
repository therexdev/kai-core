"use strict";
const assert = require("node:assert/strict"), path = require("node:path");
async function brain(win, { js, call, click, until, capture, output }) {
  await until(win, "document.querySelector('.hub-rail [data-id=overview]') && document.querySelector('.bn-main')", "Original Brain initialization");
  const sections=["overview","map","notes","goals","sources","sync","awareness","orchestration"];
  assert.deepEqual(await js(win,"[...document.querySelectorAll('.hub-rail [data-hub-action=tab]')].map(n=>n.dataset.id)"),sections);
  for(const section of sections){
    await click(win,`[data-hub-action="tab"][data-id="${section}"]`);
    await until(win,`document.querySelector('.hub-rail .active')?.dataset.id===${JSON.stringify(section)} && !!document.querySelector('.bn-main')`,"Brain "+section);
  }
  await click(win,'[data-hub-action="tab"][data-id="notes"]');
  await until(win,"document.querySelector('[data-hub-action=newNote]')","Original memory list");
  await click(win,'[data-hub-action="newNote"]');
  await until(win,"document.querySelector('[data-hub-form=note]')","Original memory editor");
  await js(win,`document.querySelector('[name=title]').value='Original Brain parity memory';document.querySelector('[name=text]').value='Synthetic memory through the original Brain editor and store';document.querySelector('[data-hub-form=note]').requestSubmit();void 0`);
  await until(win,"document.querySelector('.bn-memory')?.parentElement.innerText.includes('Original Brain parity memory')","Save original Brain memory");
  assert.ok((await call(win,"brain.ui.status")).notes.some(note=>note.title==="Original Brain parity memory"));
  await click(win,'[data-hub-action="tab"][data-id="sources"]');
  await until(win,"document.querySelector('[data-brain-form=source]')","Original Brain source editor");
  assert.deepEqual(await js(win,"[...document.querySelector('#bn-source-kind').options].map(n=>n.value)"),["folder","chats","web","rss","github"]);
  assert.equal(await call(win,"brain.ui.exportBrainVault",{}),null,"Canceled native export must not write a vault");
  await click(win,'[data-hub-action="tab"][data-id="overview"]');
  await capture(win,path.join(output,"kai.brain.original.png"));
  return "All eight original Brain sections, memory graph/editor/store, source-kind selector, original Awareness/Orchestration and cancelled native vault export";
}
async function connections(win, { js, call, click, until, capture, output }) {
  await until(win,"document.querySelectorAll('.cn-app-card').length===72","Original app catalog");
  assert.deepEqual(await js(win,"[...document.querySelectorAll('.hub-rail [data-hub-action=tab]')].map(n=>n.dataset.id)"),["explore","connected","setup","apis","tools"]);
  await js(win,"document.querySelector('#cn-search').value='Google Drive';document.querySelector('#cn-search').dispatchEvent(new Event('input',{bubbles:true}));void 0");
  await until(win,"[...document.querySelectorAll('.cn-app-card strong')].some(n=>n.textContent==='Google Drive')","Original searchable catalog");
  await click(win,'.cn-app-card');await until(win,"document.querySelector('.cn-drawer')","Original app details drawer");await click(win,'[data-cn="close"]');
  for(const section of ["connected","setup","apis","tools"]){await click(win,`[data-hub-action="tab"][data-id="${section}"]`);await until(win,`document.querySelector('.hub-rail .active')?.dataset.id===${JSON.stringify(section)}`,"Connections "+section);}
  await click(win,'[data-hub-action="tab"][data-id="apis"]');await until(win,"document.querySelector('[data-hub-action=newConnection]')","Original API list");
  await click(win,'[data-hub-action="newConnection"]');await until(win,"document.querySelector('[data-hub-form=connection]')","Original API editor");
  await js(win,`document.querySelector('[name=name]').value='Original API parity';document.querySelector('[name=baseUrl]').value='https://example.test';document.querySelector('[name=secret]').value='synthetic-parity-token';document.querySelector('[name=operations]').value=JSON.stringify([{id:'read',name:'Read',method:'GET',path:'/items'}]);document.querySelector('[data-hub-form=connection]').requestSubmit();void 0`);
  await until(win,"document.querySelector('.hub-content')?.innerText.includes('Original API parity')&&!document.querySelector('[data-hub-form=connection]')","Original API save");
  const state=await call(win,"connections.ui.status");assert.ok(state.connections.some(connection=>connection.name==="Original API parity"));assert.doesNotMatch(JSON.stringify(state),/synthetic-parity-token/);assert.deepEqual(state.notes,[]);
  await click(win,'[data-hub-action="tab"][data-id="explore"]');await capture(win,path.join(output,"kai.connections.original.png"));
  return "All five original Connections sections, full searchable catalog and app drawer, original custom API editor/save and credential isolation";
}
module.exports={brain,connections};
