"use strict";
const pluginId = "kai.model-compare";
const permissions = Object.freeze({ "compare.request": "compare.run", "compare.poll": "compare.run", "compare.cancel": "compare.run" });
function create(ctx) {
  const requests = require("./feature-requests").createFeatureRequests(ctx, "model-compare", input => {
    const path = String(input.path || "").split("?")[0], method = String(input.method || "GET").toUpperCase();
    if (!(method === "GET" && ["/core/models", "/core/network"].includes(path) || method === "POST" && path === "/core/chat/completions")) throw Error("Model Compare request denied");
  });
  return { call(method, input, signal) {
    if (!Object.hasOwn(permissions, method)) throw Error("Unknown comparison operation");
    return requests[method.slice(8)](input, signal);
  }, dispose: () => requests.dispose() };
}
module.exports = { pluginId, permissions, create };
