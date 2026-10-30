"use strict";
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const { assertPublicTarget, publicPageRequest } = require("../public-http");
const { MAX_BYTES } = require("./package");
const { verifyPackageFile } = require("./package-file-verifier");
async function downloadPackage(url, { signal = AbortSignal.timeout(900000), lookup, request = publicPageRequest, onProgress = () => {} } = {}) {
  for (let redirects=0;redirects<=5;redirects++) {
    signal.throwIfAborted();const u=new URL(url);
    if(u.protocol!=="https:"||u.username||u.password||(u.port&&u.port!=="443"))throw Error("Plugins require a public HTTPS URL without credentials");
    const addresses=await assertPublicTarget(u.href,{...(lookup?{lookup}:{})});signal.throwIfAborted();
    const response=await request(u.href,{addresses,signal,headers:{accept:"application/json","accept-encoding":"identity"}});
    if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();const location=response.headers.get("location");if(!location)throw Error("Plugin redirect has no location");url=new URL(location,u).href;continue;}
    if(!response.ok){await response.body?.cancel();throw Error(`Plugin download failed (${response.status})`);}
    if(!response.body)throw Error("Plugin download has no body");
    const length=Number(response.headers.get("content-length"))||null;
    if(length&&length>MAX_BYTES){await response.body.cancel();throw Error("Plugin exceeds 512 MB");}
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),"kai-plugin-download-")),file=path.join(directory,"package.json");
    let handle,reader,verified,retained=false,size=0,last=0;
    try{
      handle=await fs.open(file,"wx",0o600);reader=response.body.getReader();
      for(;;){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)throw Error("Plugin exceeds 512 MB");let offset=0;while(offset<value.length){const written=await handle.write(value,offset,value.length-offset);if(!written.bytesWritten)throw Error("Plugin download could not be saved");offset+=written.bytesWritten;}
        if(Date.now()-last>500){last=Date.now();onProgress({received:size,total:length});}}
      await handle.close();handle=null;signal.throwIfAborted();onProgress({received:size,total:length,verifying:true});
      verified=await verifyPackageFile(file,{extract:false});signal.throwIfAborted();retained=true;
      return Object.freeze({...verified,dispose:async()=>{try{await verified.dispose();}finally{await fs.rm(directory,{recursive:true,force:true});}}});
    }finally{await reader?.cancel().catch(()=>{});await handle?.close().catch(()=>{});if(!retained){try{await verified?.dispose();}finally{await fs.rm(directory,{recursive:true,force:true});}}}
  }
  throw Error("Too many plugin download redirects");
}
module.exports={downloadPackage};
