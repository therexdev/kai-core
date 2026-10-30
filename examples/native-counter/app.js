"use strict";
const count = document.getElementById("count"), status = document.getElementById("status"), increment = document.getElementById("increment");
async function call(method) {
  increment.disabled = true;
  try { const result = await window.kai.call(method, {}); count.textContent = String(result.count); status.textContent = ""; }
  catch (error) { status.textContent = error.message; }
  finally { increment.disabled = false; }
}
increment.addEventListener("click", () => { void call("counter.increment"); });
void call("counter.read");
