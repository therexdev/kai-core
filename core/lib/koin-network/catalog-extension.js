"use strict";
const P = require("./job-protocol");
// A catalog extension grants no wallet authority. Payment and device identities
// remain pinned to the base policy; only explicitly listed model jobs use it.
function validate(value, baseHash) {
  if (value === undefined || value === null) return null;
  if (Object.keys(value).sort().join() !== "models,policyHash,schema" || value.schema !== 1 ||
      !Array.isArray(value.models) || !value.models.length || value.models.length > 63 ||
      new Set(value.models).size !== value.models.length || value.models.some(m => typeof m !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(m))) throw Error("Exact additive model catalog required");
  P.digest(value.policyHash); P.digest(baseHash);
  if (value.policyHash === baseHash) throw Error("Catalog extension must have its own commitment");
  return Object.freeze({schema:1,policyHash:value.policyHash,models:Object.freeze([...value.models])});
}
function target(base, extension, model) {
  const checked = validate(extension, base.policyHash);
  return {...base, policyHash:checked?.models.includes(model) ? checked.policyHash : base.policyHash};
}
function headers(config) { return config.catalogExtension ? {"x-kai-catalog-policy":validate(config.catalogExtension,config.policyHash).policyHash} : {}; }
module.exports = {validate,target,headers};
