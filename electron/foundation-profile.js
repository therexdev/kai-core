"use strict";
const fs=require("node:fs"),path=require("node:path");
function prepareFoundationProfile(dataDir){
  dataDir=path.resolve(dataDir);fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  if(!fs.lstatSync(dataDir).isDirectory()||fs.lstatSync(dataDir).isSymbolicLink())throw Error("Choose a real Foundation profile directory");
  const marker=path.join(dataDir,"foundation-profile.json");
  if(!fs.existsSync(marker)){
    if(fs.readdirSync(dataDir).length)throw Error("This directory contains an earlier profile. Foundation needs a new empty profile; existing data was left untouched.");
    fs.writeFileSync(marker,JSON.stringify({schema:1,createdAt:new Date().toISOString()}),{flag:"wx",mode:0o600});
  }else{
    const st=fs.lstatSync(marker);if(!st.isFile()||st.isSymbolicLink()||st.size>4096)throw Error("Invalid Foundation profile marker");
    if(JSON.parse(fs.readFileSync(marker,"utf8")).schema!==1)throw Error("Unsupported Foundation profile");
  }
  for(const name of ["settings.json","state.json"]){const file=path.join(dataDir,name);if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>16*1024*1024)throw Error("Unsafe profile configuration; file preserved");const value=JSON.parse(fs.readFileSync(file,"utf8"));if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Unreadable profile configuration; file preserved");}}
  return {mode:"foundation",dataDir,architecture:1};
}
module.exports={prepareFoundationProfile};
