"use strict";
const notes = document.getElementById("notes"), status = document.getElementById("status"), save = document.getElementById("save");
let edited = false; notes.addEventListener("input", () => { edited = true; });
window.kai.call("storage.get", { key: "notes" }).then(value => { if (!edited) notes.value = typeof value === "string" ? value : ""; }).catch(error => { status.textContent = error.message; });
save.addEventListener("click", async () => {
  save.disabled = true;
  try { await window.kai.call("storage.set", { key: "notes", value: notes.value }); KaiI18n.setText(status, "Saved"); }
  catch (error) { status.textContent = error.message; }
  finally { save.disabled = false; }
});
