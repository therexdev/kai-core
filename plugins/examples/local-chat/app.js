"use strict";
(async () => {
  const $ = id => document.getElementById(id);
  try {
    const models = await window.kai.call("models.list");
    for (const m of models.filter(m => m.status === "ready")) { const o = document.createElement("option"); o.value = m.alias; o.textContent = m.label || m.alias; $("model").append(o); }
    $("prompt").value = await window.kai.call("storage.get", { key: "draft" }) || "";
    if (!$("model").options.length) $("status").textContent = "Install a model in KAI Core first.";
    $("send").onclick = async () => {
      $("send").disabled = true; $("status").textContent = "Thinking…";
      try { await window.kai.call("storage.set", { key: "draft", value: $("prompt").value }); const r = await window.kai.call("inference.local", { model: $("model").value, prompt: $("prompt").value }); $("answer").textContent = r.text; $("status").textContent = ""; }
      catch (e) { $("status").textContent = e.message; } finally { $("send").disabled = false; }
    };
  } catch (e) { $("status").textContent = e.message; }
})();
