"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {signingPayload}=require("../lib/plugins/package");
const {installReleasedPackage}=require("../../scripts/foundation/apps-packages");
const coreRoot=path.resolve(__dirname,"../..");
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"kai-release-smoke-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const manifest={schema:2,apiVersion:3,id:"fixture.smoke",version:"0.3.0",name:"Smoke fixture",runtime:"sandboxed",entry:"index.html",permissions:[]},files={"index.html":"<!doctype html><p>verified</p>"};
 const key=crypto.generateKeyPairSync("ed25519"),publicBytes=key.publicKey.export({format:"der",type:"spki"});
 const pkg={manifest,files,publicKey:publicBytes.toString("base64"),signature:crypto.sign(null,Buffer.from(signingPayload(manifest,files)),key.privateKey).toString("base64")};
 const file=path.join(root,"fixture.kaiplugin");fs.writeFileSync(file,JSON.stringify(pkg));
 return{file,expected:{id:manifest.id,version:manifest.version,fingerprint:crypto.createHash("sha256").update(publicBytes).digest("hex"),url:"https://github.com/example/fixture"}};
}
test("release smoke installs only a verified matching ID, version and publisher",t=>{
 const f=fixture(t);let calls=0;
 const result=installReleasedPackage({install(pkg,options){calls++;assert.equal(pkg.manifest.id,f.expected.id);assert.equal(options.trustNative,true);assert.throws(()=>pkg.files["index.html"],/not extracted/);}},f.file,f.expected,coreRoot);
 assert.equal(calls,1);assert.equal(result.sourceBytes,fs.statSync(f.file).size);assert.match(result.sourceSha256,/^[a-f0-9]{64}$/);
});
for(const [field,value]of[["id","fixture.other"],["version","0.3.1"],["fingerprint","0".repeat(64)]])test(`release smoke rejects an unexpected ${field} before installation`,t=>{
 const f=fixture(t);let called=false;assert.throws(()=>installReleasedPackage({install(){called=true;}},f.file,{...f.expected,[field]:value},coreRoot),/differs/);assert.equal(called,false);
});
