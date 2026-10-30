"use strict";
const fs = require("node:fs");
const { BINARY } = require("./package");
// Serialize large signed packages without creating one additional multi-hundred
// megabyte JSON string and Buffer. Binary file values are canonical base64;
// text values are escaped one file at a time, preserving UTF-8 surrogate pairs.
function writePackageFile(file, pkg, { mode = 0o600 } = {}) {
  let fd, created = false;
  const putBytes = bytes => { for (let offset = 0; offset < bytes.length;) { const written = fs.writeSync(fd, bytes, offset, bytes.length-offset); if (!written) throw Error("Package file write stopped"); offset += written; } };
  const put = text => putBytes(Buffer.from(text));
  try {
    fd = fs.openSync(file, "wx", mode); created = true;
    put('{"manifest":'); put(JSON.stringify(pkg.manifest)); put(',"files":{');
    let first = true;
    for (const [name, content] of Object.entries(pkg.files)) {
      if (!first) put(","); first = false;
      put(JSON.stringify(name)); put(":");
      if (BINARY.test(name)) {
        put('"'); for (let start = 0; start < content.length; start += 256*1024) put(content.slice(start,start+256*1024)); put('"');
      } else {
        const encoded = Buffer.from(JSON.stringify(content));
        for (let start = 0; start < encoded.length; start += 256*1024) putBytes(encoded.subarray(start,start+256*1024));
      }
    }
    put('},"publicKey":'); put(JSON.stringify(pkg.publicKey)); put(',"signature":'); put(JSON.stringify(pkg.signature)); put("}"); fs.fsyncSync(fd);
  } catch (error) { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } if (created) fs.rmSync(file,{force:true}); throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { writePackageFile };
