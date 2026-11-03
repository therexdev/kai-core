"use strict";
(function () {
  const bridge = window.kaiCore, i18n = window.KaiI18n, byId = id => document.getElementById(id);
  let visible = false, pending = false, reading = false, timer, last;
  const text = (id, value) => i18n.setText(byId(id), value);
  function render(info) {
    last = info;
    text("model-storage-models-path", i18n.literal(info.modelsDir));
    text("model-storage-custom-path", info.customDir ? i18n.literal(info.customDir) : "Original file locations");
    const job = info.job, running = job?.state === "running", busy = pending || running;
    byId("model-storage-models-choose").disabled = busy;
    byId("model-storage-custom-choose").disabled = busy;
    byId("model-storage-job").hidden = !job && !pending;
    byId("model-storage-cancel").hidden = !running;
    byId("model-storage-cancel").disabled = ["saving", "cleaning"].includes(job?.phase);
    byId("model-storage-progress").hidden = !running;
    byId("model-storage-progress").value = job?.totalBytes ? Math.min(100, job.completedBytes / job.totalBytes * 100) : 0;
    let message = "Checking model folder…";
    if (!pending && running) message = ({ waiting: "Waiting for current model work…", copying: "Copying and verifying model files…", saving: "Saving model locations…", cleaning: "Finishing model transfer…" })[job.phase];
    else if (!pending && job?.state === "done") message = i18n.message`Model folder updated. ${job.copied} files copied; ${job.originalsKept} originals kept.`;
    else if (!pending && job?.state === "cancelled") message = "Transfer cancelled. Original files were kept.";
    else if (!pending && job?.state === "error") message = i18n.message`Transfer could not finish: ${job.error}`;
    text("model-storage-status", message);
    text("model-storage-detail", i18n.literal(running ? job.file || "" : job?.warnings?.join("\n") || ""));
  }
  async function refresh() {
    if (!visible || reading || bridge.isClosing()) return;
    reading = true;
    try { render(await bridge.call("storage.status")); }
    catch (error) { if (!bridge.isClosing()) { byId("model-storage-job").hidden = false; text("model-storage-status", i18n.message`Transfer could not finish: ${error.message}`); } }
    finally { reading = false; }
  }
  async function choose(kind) {
    if (pending) return;
    pending = true; if (last) render(last);
    try { await bridge.call("storage.choose", { kind }); }
    catch (error) { if (!bridge.isClosing()) await bridge.dialogs.alert(error.message, { title: "Model storage" }); }
    finally { pending = false; await refresh(); }
  }
  byId("model-storage-models-choose").onclick = () => void choose("models");
  byId("model-storage-custom-choose").onclick = () => void choose("custom");
  byId("model-storage-cancel").onclick = () => void bridge.call("storage.cancel").then(refresh);
  window.KaiModelStorage = {
    enter() { visible = true; void refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) void refresh(); }, 750); },
    leave() { visible = false; clearInterval(timer); },
  };
  bridge.onClosing(() => window.KaiModelStorage.leave());
})();
