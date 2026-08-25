// Deterministic, dependency-free zip writer and reader.
//
// This used to shell out: Info-ZIP `zip`/`unzip` when present, PowerShell
// `Compress-Archive`/`Expand-Archive` otherwise. Both halves of that fallback
// were wrong on Windows:
//
//   * Windows PowerShell's Compress-Archive writes entry names with backslash
//     separators. That violates the zip spec (APPNOTE 4.4.17: forward slashes
//     only), so a package built on Windows extracted into flat files named
//     `dir\sub\file` on Linux. Info-ZIP `unzip` warns about it and exits 1,
//     which is how the defect surfaced — as a "Windows-only test failure"
//     rather than as the packaging bug it actually was.
//   * `run()` treated any non-zero exit as fatal, so an `unzip` *warning*
//     failed the build.
//
// Doing it in Node removes the whole class of problem: one implementation, the
// same bytes on every platform, no external binaries. Entry order is sorted and
// timestamps are fixed, so an unchanged tree produces a byte-identical archive
// and the SHA-256 sums in dist/ mean something across machines.
//
// Scope: store and deflate, no zip64, no encryption. Package archives are a
// couple of megabytes; anything beyond that scope throws instead of guessing.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const LOCAL_SIG=0x04034b50, CENTRAL_SIG=0x02014b50, EOCD_SIG=0x06054b50;
// Fixed DOS timestamp (1980-01-01 00:00:00), the earliest the format can hold.
// Real mtimes would make the archive depend on checkout time.
const DOS_TIME=0, DOS_DATE=(1<<5)|1;

const CRC_TABLE=(()=>{
  const t=new Int32Array(256);
  for(let i=0;i<256;i++){
    let c=i;
    for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;
    t[i]=c;
  }
  return t;
})();
function crc32(buf){
  let c=-1;
  for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xFF]^(c>>>8);
  return (c^-1)>>>0;
}

// Mode by rule, not by the source filesystem: Windows has no execute bit, and a
// package whose `bin/agent-sdlc` is not executable after extraction on POSIX is
// broken. .gitattributes already pins these same paths to LF endings.
const executable=rel=>/(^|\/)bin\//.test(rel)||rel.endsWith('.sh');
const modeFor=rel=>executable(rel)?0o755:0o644;

function walk(dir,prefix,out){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){
    const abs=path.join(dir,entry.name);
    const rel=`${prefix}${entry.name}`;
    if(entry.isDirectory()){
      out.push({rel:`${rel}/`,dir:true});
      walk(abs,`${rel}/`,out);
    }else if(entry.isFile()){
      out.push({rel,dir:false,data:fs.readFileSync(abs)});
    }
  }
  return out;
}

/**
 * `prefix` defaults to the directory's own name, matching `zip -r`, which is
 * what the distribution packages expect. Pass `prefix:''` for a format that
 * requires entries at the archive root, such as OOXML (.docx/.xlsx) fixtures.
 */
export function zipDir(dir,zipPath,{prefix=`${path.basename(dir)}/`}={}){
  fs.rmSync(zipPath,{force:true});
  fs.mkdirSync(path.dirname(zipPath),{recursive:true});
  const entries=walk(dir,prefix,prefix?[{rel:prefix,dir:true}]:[]);

  const chunks=[],central=[];
  let offset=0;
  for(const e of entries){
    const name=Buffer.from(e.rel,'utf8');
    const raw=e.dir?Buffer.alloc(0):e.data;
    const deflated=e.dir?Buffer.alloc(0):zlib.deflateRawSync(raw,{level:9});
    // Never let "compression" grow a file: fall back to stored.
    const store=e.dir||deflated.length>=raw.length;
    const body=store?raw:deflated;
    const method=store?0:8;
    const crc=e.dir?0:crc32(raw);

    const local=Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG,0);
    local.writeUInt16LE(20,4);            // version needed
    local.writeUInt16LE(0,6);             // flags
    local.writeUInt16LE(method,8);
    local.writeUInt16LE(DOS_TIME,10);
    local.writeUInt16LE(DOS_DATE,12);
    local.writeUInt32LE(crc,14);
    local.writeUInt32LE(body.length,18);
    local.writeUInt32LE(raw.length,22);
    local.writeUInt16LE(name.length,26);
    local.writeUInt16LE(0,28);            // extra length
    chunks.push(local,name,body);

    const cd=Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG,0);
    cd.writeUInt16LE((3<<8)|20,4);        // made by: UNIX, spec 2.0
    cd.writeUInt16LE(20,6);
    cd.writeUInt16LE(0,8);
    cd.writeUInt16LE(method,10);
    cd.writeUInt16LE(DOS_TIME,12);
    cd.writeUInt16LE(DOS_DATE,14);
    cd.writeUInt32LE(crc,16);
    cd.writeUInt32LE(body.length,20);
    cd.writeUInt32LE(raw.length,24);
    cd.writeUInt16LE(name.length,28);
    cd.writeUInt16LE(0,30);               // extra
    cd.writeUInt16LE(0,32);               // comment
    cd.writeUInt16LE(0,34);               // disk
    cd.writeUInt16LE(0,36);               // internal attrs
    // Multiply rather than shift: `mode << 16` overflows into a negative
    // 32-bit signed value, which writeUInt32LE rejects.
    const unixMode=(modeFor(e.rel)|(e.dir?0o040000:0o100000))&0xFFFF;
    cd.writeUInt32LE(unixMode*0x10000+(e.dir?0x10:0),38);
    cd.writeUInt32LE(offset,42);
    central.push(cd,name);

    offset+=local.length+name.length+body.length;
  }

  const centralBuf=Buffer.concat(central);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG,0);
  eocd.writeUInt16LE(0,4);
  eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(entries.length,8);
  eocd.writeUInt16LE(entries.length,10);
  eocd.writeUInt32LE(centralBuf.length,12);
  eocd.writeUInt32LE(offset,16);
  eocd.writeUInt16LE(0,20);
  if(entries.length>0xFFFF||offset>0xFFFFFFFF)throw new Error('archive exceeds zip32 limits; zip64 is not implemented');

  fs.writeFileSync(zipPath,Buffer.concat([...chunks,centralBuf,eocd]));
  return {tool:'node',entries:entries.length,bytes:fs.statSync(zipPath).size};
}

// Entry names are normalized and then constrained to the destination. An
// archive can name `../../etc/passwd` or `C:\Windows\...`, and extraction is the
// moment that becomes a write outside the target. Backslash separators are
// folded here too, so archives produced by older Windows builds still extract
// into the right tree.
function safeJoin(destDir,rawName){
  const normalized=rawName.replace(/\\/g,'/').replace(/^\/+/,'');
  if(/^[A-Za-z]:/.test(normalized))throw new Error(`refusing absolute entry path: ${rawName}`);
  const abs=path.resolve(destDir,normalized);
  const root=path.resolve(destDir);
  if(abs!==root&&!abs.startsWith(root+path.sep))throw new Error(`refusing entry outside destination: ${rawName}`);
  return abs;
}

export function unzipTo(zipPath,destDir){
  fs.mkdirSync(destDir,{recursive:true});
  const buf=fs.readFileSync(zipPath);

  let eocd=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-66*1024);i--)
    if(buf.readUInt32LE(i)===EOCD_SIG){eocd=i;break;}
  if(eocd<0)throw new Error(`not a zip archive (no end-of-central-directory): ${zipPath}`);
  const count=buf.readUInt16LE(eocd+10);
  const cdSize=buf.readUInt32LE(eocd+12);
  const cdOffset=buf.readUInt32LE(eocd+16);
  if(count===0xFFFF||cdOffset===0xFFFFFFFF||cdSize===0xFFFFFFFF)
    throw new Error('zip64 archive; zip64 is not implemented');

  let p=cdOffset;
  const written=[];
  for(let i=0;i<count;i++){
    if(buf.readUInt32LE(p)!==CENTRAL_SIG)throw new Error(`corrupt central directory at ${p}`);
    const method=buf.readUInt16LE(p+10);
    const crc=buf.readUInt32LE(p+16);
    const compressedSize=buf.readUInt32LE(p+20);
    const uncompressedSize=buf.readUInt32LE(p+24);
    const nameLen=buf.readUInt16LE(p+28);
    const extraLen=buf.readUInt16LE(p+30);
    const commentLen=buf.readUInt16LE(p+32);
    const madeBy=buf.readUInt16LE(p+4)>>8;
    const externalAttrs=buf.readUInt32LE(p+38);
    const localOffset=buf.readUInt32LE(p+42);
    const name=buf.toString('utf8',p+46,p+46+nameLen);
    p+=46+nameLen+extraLen+commentLen;

    // The local header repeats name/extra lengths; the data starts after them.
    if(buf.readUInt32LE(localOffset)!==LOCAL_SIG)throw new Error(`corrupt local header for ${name}`);
    const localNameLen=buf.readUInt16LE(localOffset+26);
    const localExtraLen=buf.readUInt16LE(localOffset+28);
    const dataStart=localOffset+30+localNameLen+localExtraLen;
    const target=safeJoin(destDir,name);

    if(name.endsWith('/')||name.endsWith('\\')){fs.mkdirSync(target,{recursive:true});continue;}
    const stored=buf.subarray(dataStart,dataStart+compressedSize);
    let data;
    if(method===0)data=stored;
    else if(method===8)data=zlib.inflateRawSync(stored);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if(data.length!==uncompressedSize)throw new Error(`size mismatch for ${name}`);
    if(crc32(data)!==crc)throw new Error(`CRC mismatch for ${name}`);

    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,data);
    // Restore the execute bit where the archive recorded UNIX modes. A no-op on
    // Windows, which is fine: nothing there consults it.
    if(madeBy===3){
      const mode=(externalAttrs>>>16)&0o7777;
      if(mode)try{fs.chmodSync(target,mode);}catch{}
    }
    written.push(name);
  }
  return {tool:'node',entries:written.length};
}
