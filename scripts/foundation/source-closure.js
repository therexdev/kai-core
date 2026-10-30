"use strict";
const fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,"../..");
function closure(entries){
 const seen=new Set(),external=new Set(),missing=[];
 function visit(file){file=path.resolve(root,file);if(seen.has(file))return;if(!fs.existsSync(file)){missing.push(path.relative(root,file));return;}seen.add(file);if(!/\.(?:c?js|mjs)$/.test(file))return;
 const source=fs.readFileSync(file,"utf8");for(const m of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)){const name=m[1];if(!name.startsWith(".")){if(!name.startsWith("node:"))external.add(name);continue;}const target=path.resolve(path.dirname(file),name);const found=[target,target+".js",target+".json",path.join(target,"index.js")].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());if(found)visit(found);else missing.push(path.relative(root,target));}}
 entries.forEach(visit);return {files:[...seen].map(p=>path.relative(root,p).replaceAll(path.sep,"/")).sort(),external:[...external].sort(),missing};
}
const entries=["electron/core-main.js","electron/core-preload.js","electron/core-plugin-preload.js","electron/core-plugin-install-preload.js"];
if(require.main===module){const graph=closure(entries);process.stdout.write(JSON.stringify(graph,null,2)+"\n");if(graph.missing.length)process.exitCode=1;}
module.exports={closure,entries};
