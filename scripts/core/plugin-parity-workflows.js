"use strict";
// Invoked by the real signed-plugin desktop smoke. All data/model traffic is
// synthetic; these routines exercise the original renderers and real brokers.
const assert = require("node:assert/strict"), path = require("node:path");
async function originalRail(win, js) {
  const layout = await js(win, `(() => { const shell=document.querySelector('.hub-shell'),rail=shell.querySelector('.hub-rail'),pane=shell.querySelector('.hub-content'); const r=rail.getBoundingClientRect(),p=pane.getBoundingClientRect();return {display:getComputedStyle(shell).display,direction:getComputedStyle(rail).flexDirection,railWidth:r.width,paneTop:p.top,paneLeft:p.left,railRight:r.right,paneWidth:p.width,viewport:innerHeight};})()`);
  assert.equal(layout.display, "grid", "Original companion workspace grid is missing");
  assert.equal(layout.direction, "column", "Original vertical section rail is missing");
  assert.ok(layout.railWidth >= 100 && layout.railWidth < 250 && layout.paneLeft >= layout.railRight - 1 && layout.paneWidth > 400 && layout.paneTop < layout.viewport / 2, "Original content pane is not visible beside its rail: " + JSON.stringify(layout));
}
async function workflow(win, { js, call, click, until, capture, output }) {
  await until(win, "document.querySelector('[data-section=templates]') && document.querySelector('[data-wf=new]')", "Original Workflows initialization");
  await originalRail(win, js);
  const sections = await js(win, "[...document.querySelectorAll('[data-section]')].map(b=>b.textContent)");
  assert.deepEqual(sections, ["My workflows", "Run history", "Templates", "Discover workflows"]);
  const migrated = (await call(win, "workflows.status")).workflows.find(workflow => workflow.legacyTask?.id === "synthetic-legacy-task");
  assert.ok(migrated, "Earlier scheduled tasks must migrate into the original Workflows workspace");
  assert.equal(migrated.enabled, false, "Migration must retain a paused scheduled task");
  assert.equal(migrated.legacyTask.lastChatId, "synthetic-legacy-chat");
  assert.ok(migrated.graph.nodes.some(node => node.type === "agent" && node.config.prompt === "Preserve this scheduled prompt."));
  assert.ok(migrated.graph.nodes.some(node => node.type === "output" && node.config.saveChat === true));
  await click(win, '[data-section="templates"]'); await until(win, "document.querySelectorAll('[data-wf=template]').length>=9", "All original workflow templates");
  await click(win, '[data-section="discover"]'); await until(win, "document.querySelector('[data-wf-form=discoverySettings]')", "Original workflow discovery and daily suggestions");
  await click(win, '[data-section="templates"]'); await until(win, "document.querySelector('[data-wf=template][data-id=ask]')", "Workflow template return");
  await click(win, '[data-wf="template"][data-id="ask"]'); await until(win, "document.querySelector('.wf-builder') && document.querySelector('.wf-palette')", "Original workflow graph builder");
  const palette = await js(win, "[...document.querySelectorAll('.wf-palette [data-wf=add]')].map(b=>b.dataset.id)");
  for (const type of ["agent", "memory", "tool_call", "http_request", "code", "loop", "sub_workflow", "approval"]) assert.ok(palette.includes(type), "Original node missing: " + type);
  await click(win, '[data-wf="inspector"][data-id="settings"]');
  await js(win, `(() => { const input=document.querySelector('[data-field=name]');input.value='Original workflow smoke';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await click(win, '[data-wf="save"]'); await until(win, "document.querySelector('.wf-notice')?.innerText.includes('Workflow saved')", "Save through original graph editor");
  await capture(win, path.join(output, "kai.workflows.builder.png"));
  const saved = (await call(win, "workflows.status")).workflows.find(w => w.name === "Original workflow smoke"); assert.ok(saved?.graph);
  const { id } = await call(win, "workflows.run", { id: saved.id, input: "Synthetic full workflow input" });
  await until(win, `window.kai.call('workflows.runGet',{id:${JSON.stringify(id)}}).then(r=>r.status==='completed'||r.status==='failed')`, "Original workflow engine execution");
  const result = await call(win, "workflows.runGet", { id }); assert.equal(result.status, "completed", JSON.stringify(result));
  await click(win, '[data-wf="back"]'); await until(win, "document.querySelector('[data-section=runs]')", "Return to workflow list");
  await click(win, '[data-section="runs"]'); await until(win, "document.querySelector('.wf-run')", "Full original run history");
  await click(win, '[data-wf="runCanvas"]'); await until(win, "document.body.innerText.includes('Run snapshot')", "Historical workflow canvas");
  await click(win, '[data-wf="back"]');
  return "Original four-section Workflows rail, preserved scheduled-task migration, all templates and graph node types, settings/edit/save, real model execution, full history and run snapshot canvas";
}
async function agentNetwork(win, { js, call, click, until, features }) {
  await until(win, "document.querySelector('[data-an=tab][data-id=settings]')", "Original Agent Network initialization");
  await originalRail(win, js);
  assert.deepEqual(await js(win, "[...document.querySelectorAll('.hub-rail [data-an=tab]')].map(b=>b.dataset.id)"), ["discover", "mine", "jobs", "earnings", "activity", "settings"]);
  await click(win, '[data-an="tab"][data-id="settings"]'); await until(win, "document.querySelector('[data-an-form=settings]')", "Network settings");
  const confirm = features.ctx.confirm;
  features.ctx.confirm = async (title, detail) => ["Start private agent services", "Run this free service", "Accept jobs on this device"].includes(title) ? true : confirm(title, detail);
  try {
    await js(win, "document.querySelector('[name=enabled]').checked=true;document.querySelector('[data-an-form=settings]').requestSubmit();void 0");
    await until(win, "document.body.innerText.includes('Saved.')", "Enable isolated service identity");
    await click(win, '[data-an="tab"][data-id="mine"]'); await click(win, '[data-an="create"]');
    await until(win, "document.querySelector('[data-an-form=save]')", "Original agent editor");
    await js(win, "document.querySelector('[name=name]').value='Original echo service';document.querySelector('[name=description]').value='Synthetic service with no model or private context';document.querySelector('[name=template]').value='echo';document.querySelector('[data-an-form=save]').requestSubmit();void 0");
    await until(win, "document.querySelector('.an-card')?.innerText.includes('Original echo service')", "Original agent save");
    const state = await call(win, "agentNetwork.legacyStatus"), service = state.agents.find(a => a.card.payload.name === "Original echo service"); assert.ok(service?.definition.graph); assert.ok(Array.isArray(state.activity));
    await click(win, '[data-an="hire"]'); await until(win, "document.querySelector('[data-an-form=hire]')", "Original service request form");
    await js(win, "document.querySelector('[name=input]').value='Synthetic private service input';document.querySelector('[data-an-form=hire]').requestSubmit();void 0");
    await until(win, "document.body.innerText.includes('Review & send input')", "Signed local quote");
    await click(win, '[data-an="submit"]');
    await until(win, "window.kai.call('agentNetwork.legacyRefresh',{}).then(s=>s.jobs.some(j=>j.role==='buyer'&&j.status==='delivered'))", "Isolated local service delivery");
    const delivered = (await call(win, "agentNetwork.legacyStatus")).jobs.find(j => j.role === "buyer" && j.status === "delivered"); assert.equal(delivered.output, "Synthetic private service input");
    await call(win, "agentNetwork.job", { id: delivered.id, role: "buyer", action: "accept" });
    for (const section of ["activity", "earnings", "discover", "mine", "jobs", "settings"]) { await click(win, `[data-an="tab"][data-id="${section}"]`); await until(win, "document.querySelector('.hub-content h1')", "Agent Network " + section); }
    assert.doesNotMatch(JSON.stringify(await call(win, "agentNetwork.legacyStatus")), /encryption_private|signing_private|wallet\.json/);
  } finally { features.ctx.confirm = confirm; }
  return "Original six-section Agent Network, full agent editor, signed quote, real isolated local job, full input/delivery/activity and explicit result acceptance";
}
module.exports = { workflow, agentNetwork };
