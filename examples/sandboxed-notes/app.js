"use strict";
const note = document.getElementById("note"), status = document.getElementById("status"), save = document.getElementById("save");
async function load() {
  try { const value = await window.kai.call("storage.get", { key: "note" }); note.value = typeof value === "string" ? value : ""; }
  catch (error) { status.textContent = error.message; save.disabled = true; }
}
save.addEventListener("click", async () => {
  save.disabled = true;
  try { await window.kai.call("storage.set", { key: "note", value: note.value }); status.textContent = "Saved"; }
  catch (error) { status.textContent = error.message; }
  finally { save.disabled = false; }
});
void load();
