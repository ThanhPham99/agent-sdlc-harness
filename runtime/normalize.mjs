import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256} from './util.mjs';

const TEXT_EXTS=new Set(['.txt','.md','.mdx','.rst','.adoc','.json','.jsonl','.yaml','.yml','.toml','.ini','.cfg','.csv','.tsv','.log','.xml','.html','.htm','.sql']);
const IMAGE_EXTS=new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff','.heic','.heif']);

// The largest column an XLSX file may address is XFD. A crafted cell reference
// beyond it used to be honoured: `r="ZZZZZ1"` padded the row to 12.3 million
// cells, turning a 1 KB workbook into a 111 MB markdown artifact, and one letter
// more threw `RangeError: Invalid array length`. Malformed references are
// dropped rather than trusted.
export const MAX_COLUMNS=16384;

// Total extracted text per document, across every part the container declares.
//
// unzip's maxBuffer bounds one entry; nothing bounded a document. A .docx may
// declare any number of word/headerN.xml parts and a .xlsx any number of
// sheets, and the parser extracted all of them -- so a small archive of highly
// compressible parts expanded without limit, and normalizeInput's maxBytes (a
// limit on the archive, not on what it unpacks to) said nothing about it. Same
// shape as MAX_COLUMNS above: a dimension the format leaves open that the
// parser has to close.
//
// Reaching the budget is not a parse failure. What was extracted before the
// limit is still the requirement someone needs, so it is returned -- with a
// reason saying it was cut short, so a caller never mistakes a truncated
// document for a whole one.
export const MAX_EXTRACTED_BYTES=8*1024*1024;

/** Accumulates parts until the budget is spent, then reports that it stopped. */
function budget(limit=MAX_EXTRACTED_BYTES){
  let used=0,exceeded=false;
  return {
    /** true when `text` fitted and was counted; false once the budget is spent. */
    add(text){
      if(exceeded)return false;
      const size=Buffer.byteLength(text);
      if(used+size>limit){exceeded=true;return false;}
      used+=size;
      return true;
    },
    get exceeded(){return exceeded;}
  };
}

/**
 * A character reference outside the Unicode range is left as literal text.
 * `String.fromCodePoint` throws on it, and a malformed document must produce a
 * status, never an exception from inside the parser.
 */
function codePoint(match,n){
  if(!Number.isSafeInteger(n)||n<0||n>0x10FFFF)return match;
  try{return String.fromCodePoint(n);}catch{return match;}
}
function decodeXml(s=''){
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#(\d+);/g,(m,n)=>codePoint(m,Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(m,n)=>codePoint(m,parseInt(n,16)));
}
function stripXml(xml){
  return decodeXml(xml)
    .replace(/<w:tab\b[^>]*\/>/g,'\t')
    .replace(/<w:br\b[^>]*\/>/g,'\n')
    .replace(/<\/w:p>/g,'\n')
    .replace(/<\/w:tr>/g,'\n')
    .replace(/<\/w:tc>/g,'\t')
    .replace(/<[^>]+>/g,'')
    .replace(/\r/g,'')
    .replace(/[ \t]+\n/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}
function commandExists(bin){
  const r=spawnSync(bin,['--help'],{encoding:'utf8',timeout:3000});
  return !r.error && (r.status===0 || r.status===1 || r.status===2);
}
// Entry names come from inside the archive, so for XLSX they are attacker
// controlled: a sheet target is read from xl/_rels/workbook.xml.rels. A name
// beginning with `-` would reach `unzip` as an option rather than a member, and
// `..` or an absolute path has no legitimate use in an OOXML container.
const SAFE_ENTRY=/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/;
function safeEntry(entry){
  return typeof entry==='string'&&entry.length<=255&&SAFE_ENTRY.test(entry)&&!entry.includes('..');
}
function unzipEntry(file,entry){
  if(!safeEntry(entry))throw new Error(`refusing unsafe archive entry name: ${String(entry).slice(0,60)}`);
  const r=spawnSync('unzip',['-p',file,entry],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:15000});
  // An entry larger than maxBuffer, or a hung unzip, leaves status null and an
  // error rather than a non-zero exit; say which it was.
  if(r.error)throw new Error(`unzip could not read ${entry}: ${r.error.code||r.error.message}`);
  if(r.status!==0) throw new Error(`unzip failed for ${entry}: ${(r.stderr||'').trim()}`);
  return r.stdout||'';
}
function unzipList(file){
  const r=spawnSync('unzip',['-Z1',file],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:15000});
  if(r.status!==0) throw new Error(`unzip list failed: ${(r.stderr||'').trim()}`);
  return (r.stdout||'').split(/\r?\n/).filter(Boolean);
}
function docxText(file){
  if(!commandExists('unzip')) return {status:'PENDING',reason:'UNZIP_NOT_AVAILABLE',text:''};
  const entries=unzipList(file);
  const parts=[];
  const room=budget();
  // document.xml leads the list, so the body claims the budget before any
  // number of header/footer parts can consume it.
  const ordered=['word/document.xml',...entries.filter(x=>/^word\/(header|footer)\d+\.xml$/.test(x)).sort(),...entries.filter(x=>/^word\/(footnotes|endnotes|comments)\.xml$/.test(x)).sort()];
  for(const e of ordered){
    if(!entries.includes(e))continue;
    const t=stripXml(unzipEntry(file,e));
    if(!t)continue;
    const section=`## ${e}\n\n${t}`;
    if(!room.add(section))break;
    parts.push(section);
  }
  if(!parts.length)return {status:'PENDING',reason:'DOCX_TEXT_NOT_FOUND',text:''};
  return {status:'NORMALIZED',reason:room.exceeded?'EXTRACTION_BUDGET_EXCEEDED':null,text:parts.join('\n\n')};
}
function sharedStrings(xml){
  if(!xml)return [];
  const out=[];
  for(const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)){const seg=m[1];const texts=[...seg.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>decodeXml(x[1]));out.push(texts.join(''));}
  return out;
}
/** Zero-based column index, or -1 when the reference is outside the format. */
function colIndex(ref='A1'){
  const letters=(ref.match(/[A-Z]+/i)||['A'])[0].toUpperCase();
  // Five letters already exceed XFD; stop before the arithmetic can run away.
  if(letters.length>5)return -1;
  let n=0;for(const c of letters)n=n*26+(c.charCodeAt(0)-64);
  return n>=1&&n<=MAX_COLUMNS?n-1:-1;
}
function xlsxText(file){
  if(!commandExists('unzip')) return {status:'PENDING',reason:'UNZIP_NOT_AVAILABLE',text:''};
  const entries=unzipList(file);let strings=[];
  if(entries.includes('xl/sharedStrings.xml'))strings=sharedStrings(unzipEntry(file,'xl/sharedStrings.xml'));
  let workbook=entries.includes('xl/workbook.xml')?unzipEntry(file,'xl/workbook.xml'):'';
  let rels=entries.includes('xl/_rels/workbook.xml.rels')?unzipEntry(file,'xl/_rels/workbook.xml.rels'):'';
  const relMap=new Map();for(const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?\s*>/g))relMap.set(m[1],m[2]);
  const sheets=[];for(const m of workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"[^>]*\/?\s*>/g)){let target=relMap.get(m[2]);if(target){target=target.replace(/^\//,'');if(!target.startsWith('xl/'))target='xl/'+target.replace(/^\.\//,'');sheets.push({name:decodeXml(m[1]),entry:target});}}
  if(!sheets.length){for(const entry of entries.filter(e=>/^xl\/worksheets\/sheet\d+\.xml$/.test(e)).sort())sheets.push({name:path.basename(entry,'.xml'),entry});}
  const sections=[];
  const room=budget();
  for(const s of sheets){if(!entries.includes(s.entry))continue;if(room.exceeded)break;const xml=unzipEntry(file,s.entry);const rows=[];
    for(const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){const cells=[];for(const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){const attrs=cm[1],body=cm[2];const ref=(attrs.match(/\br="([^"]+)"/)||[])[1]||'';const type=(attrs.match(/\bt="([^"]+)"/)||[])[1]||'';let val='';const vm=body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);const im=body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);if(type==='s'&&vm)val=strings[Number(vm[1])]??'';else if(type==='inlineStr'&&im)val=[...im[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>decodeXml(x[1])).join('');else if(vm)val=decodeXml(vm[1]);const idx=colIndex(ref);if(idx<0)continue;while(cells.length<idx)cells.push('');cells[idx]=String(val).replace(/\|/g,'\\|').replace(/\r?\n/g,' ');}
      if(cells.some(x=>x!==''))rows.push(cells);
    }
    // reduce, not Math.max(...spread): a wide sheet would overflow the stack.
    if(rows.length){const width=rows.reduce((w,r)=>Math.max(w,r.length),0);const norm=rows.map(r=>Array.from({length:width},(_,i)=>r[i]??''));const header=norm[0];const lines=[`## Sheet: ${s.name}`,'',`| ${header.join(' | ')} |`,`| ${header.map(()=> '---').join(' | ')} |`,...norm.slice(1).map(r=>`| ${r.join(' | ')} |`)];const section=lines.join('\n');if(!room.add(section))break;sections.push(section);}
  }
  if(!sections.length)return {status:'PENDING',reason:'XLSX_TEXT_NOT_FOUND',text:''};
  return {status:'NORMALIZED',reason:room.exceeded?'EXTRACTION_BUDGET_EXCEEDED':null,text:sections.join('\n\n')};
}
function pdfText(file){
  if(!commandExists('pdftotext'))return {status:'PENDING',reason:'PDFTOTEXT_NOT_AVAILABLE',text:''};
  const r=spawnSync('pdftotext',['-layout',file,'-'],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:30000});
  if(r.status!==0)return {status:'PENDING',reason:'PDF_TEXT_EXTRACTION_FAILED',detail:(r.stderr||'').trim(),text:''};
  const text=(r.stdout||'').replace(/\f/g,'\n\n---\n\n').trim();
  if(!text)return {status:'NEEDS_MULTIMODAL',reason:'PDF_HAS_NO_EXTRACTABLE_TEXT',text:''};
  return {status:'NORMALIZED',text};
}
function textFile(file,ext){
  let t=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
  if(ext==='.json'){try{t=JSON.stringify(JSON.parse(t),null,2);}catch{}}
  return {status:'NORMALIZED',text:t.trim()};
}
export function normalizeInput(file,{maxBytes=20*1024*1024}={}){
  const abs=path.resolve(file);const st=fs.statSync(abs);if(!st.isFile())throw new Error('input must be a file');if(st.size>maxBytes)throw new Error(`input exceeds maxBytes=${maxBytes}`);
  const ext=path.extname(abs).toLowerCase();let r;
  // The input is untrusted by definition. A malformed or hostile document must
  // produce a normalization status the caller can act on, never an exception
  // escaping the parser: the CLI would turn that into a bare ERROR and the
  // requirement would look like a harness fault instead of a bad input.
  try{
    if(TEXT_EXTS.has(ext))r=textFile(abs,ext);
    else if(ext==='.docx')r=docxText(abs);
    else if(ext==='.xlsx')r=xlsxText(abs);
    else if(ext==='.pdf')r=pdfText(abs);
    else if(IMAGE_EXTS.has(ext))r={status:'NEEDS_MULTIMODAL',reason:'IMAGE_REQUIRES_VISION_EXTRACTION',text:''};
    else r={status:'PENDING',reason:'UNSUPPORTED_FILE_TYPE',text:''};
  }catch(e){
    r={status:'PENDING',reason:'NORMALIZATION_FAILED',detail:String(e.message).slice(0,300),text:''};
  }
  const source_sha256=sha256(fs.readFileSync(abs));
  const header=[
    '# Normalized Input', '',
    `- source_file: ${path.basename(abs)}`,
    `- source_type: ${ext||'unknown'}`,
    `- source_bytes: ${st.size}`,
    `- source_sha256: ${source_sha256}`,
    `- normalization_status: ${r.status}`,
    `- normalization_reason: ${r.reason||'none'}`,
    '', '---', ''
  ].join('\n');
  return {schema:'agent-sdlc/normalized-input/v1',source_file:abs,source_type:ext||null,source_bytes:st.size,source_sha256,status:r.status,reason:r.reason||null,detail:r.detail||null,markdown:header+(r.text||'')+(r.text?'\n':'')};
}
