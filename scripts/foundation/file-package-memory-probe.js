"use strict";
// Exercise the exact desktop review/install/launch path with a real package.
// Usage: node --expose-gc --max-old-space-size=96 ... <signed-package-file>
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict");
const {verifyPackageFile}=require("../../core/lib/plugins/package-file-verifier"),{PluginManager}=require("../../core/lib/plugins/manager");
const source=process.argv[2];if(!source)throw Error("Supply a signed .kaiplugin file");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"kai-file-package-memory-")),stages=[],started=Date.now();let review,instance,reopened;
function stage(name){global.gc?.();const m=process.memoryUsage();stages.push({name,elapsedMs:Date.now()-started,rssMiB:Math.round(m.rss/1048576),heapMiB:Math.round(m.heapUsed/1048576),maxRssMiB:Math.round(process.resourceUsage().maxRSS/1024)});}
try{
 stage("baseline");review=verifyPackageFile(source,{extract:false});stage("review-metadata-only");
 const manager=new PluginManager(root);manager.install(review.package,{trustNative:review.manifest.runtime==="native"});stage("copy-exact-approved-package");
 instance=manager.materialize(review.manifest.id);assert.equal(instance.digest,review.digest);assert.equal(fs.existsSync(path.join(instance.root,instance.manifest.service||instance.manifest.entry)),true);stage("signature-verified-code-materialized");
 reopened=manager.materialize(review.manifest.id);assert.equal(reopened.root,instance.root);assert.equal(reopened.digest,instance.digest);stage("cold-reopen-validates-existing-code");
 console.log(JSON.stringify({platform:process.platform,node:process.version,id:review.manifest.id,version:review.manifest.version,sourceBytes:review.sourceBytes,sourceDigest:review.sourceDigest,packageDigest:review.digest,fileCount:review.entries.length,stages},null,2));
}finally{review?.dispose();instance?.dispose();reopened?.dispose();fs.rmSync(root,{recursive:true,force:true});}
