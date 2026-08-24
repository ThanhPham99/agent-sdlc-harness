import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256} from './util.mjs';

const TEXT_EXTS=new Set(['.txt','.md','.mdx','.rst','.adoc','.json','.jsonl','.yaml','.yml','.toml','.ini','.cfg','.csv','.tsv','.log','.xml','.html','.htm','.sql']);
const IMAGE_EXTS=new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.tif','.tiff','.heic','.heif']);

function decodeXml(s=''){
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
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
function unzipEntry(file,entry){
  const r=spawnSync('unzip',['-p',file,entry],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:15000});
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
  const ordered=['word/document.xml',...entries.filter(x=>/^word\/(header|footer)\d+\.xml$/.test(x)).sort(),...entries.filter(x=>/^word\/(footnotes|endnotes|comments)\.xml$/.test(x)).sort()];
  for(const e of ordered){if(entries.includes(e)){const t=stripXml(unzipEntry(file,e));if(t)parts.push(`## ${e}\n\n${t}`);}}
  if(!parts.length)return {status:'PENDING',reason:'DOCX_TEXT_NOT_FOUND',text:''};
  return {status:'NORMALIZED',text:parts.join('\n\n')};
}
function sharedStrings(xml){
  if(!xml)return [];
  const out=[];
  for(const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)){const seg=m[1];const texts=[...seg.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>decodeXml(x[1]));out.push(texts.join(''));}
  return out;
}
function colIndex(ref='A1'){
  const letters=(ref.match(/[A-Z]+/i)||['A'])[0].toUpperCase();let n=0;for(const c of letters)n=n*26+(c.charCodeAt(0)-64);return n-1;
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
  for(const s of sheets){if(!entries.includes(s.entry))continue;const xml=unzipEntry(file,s.entry);const rows=[];
    for(const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){const cells=[];for(const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){const attrs=cm[1],body=cm[2];const ref=(attrs.match(/\br="([^"]+)"/)||[])[1]||'';const type=(attrs.match(/\bt="([^"]+)"/)||[])[1]||'';let val='';const vm=body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);const im=body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);if(type==='s'&&vm)val=strings[Number(vm[1])]??'';else if(type==='inlineStr'&&im)val=[...im[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>decodeXml(x[1])).join('');else if(vm)val=decodeXml(vm[1]);const idx=colIndex(ref);while(cells.length<idx)cells.push('');cells[idx]=String(val).replace(/\|/g,'\\|').replace(/\r?\n/g,' ');}
      if(cells.some(x=>x!==''))rows.push(cells);
    }
    if(rows.length){const width=Math.max(...rows.map(r=>r.length));const norm=rows.map(r=>Array.from({length:width},(_,i)=>r[i]??''));const header=norm[0];const lines=[`## Sheet: ${s.name}`,'',`| ${header.join(' | ')} |`,`| ${header.map(()=> '---').join(' | ')} |`,...norm.slice(1).map(r=>`| ${r.join(' | ')} |`)];sections.push(lines.join('\n'));}
  }
  if(!sections.length)return {status:'PENDING',reason:'XLSX_TEXT_NOT_FOUND',text:''};
  return {status:'NORMALIZED',text:sections.join('\n\n')};
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
  if(TEXT_EXTS.has(ext))r=textFile(abs,ext);
  else if(ext==='.docx')r=docxText(abs);
  else if(ext==='.xlsx')r=xlsxText(abs);
  else if(ext==='.pdf')r=pdfText(abs);
  else if(IMAGE_EXTS.has(ext))r={status:'NEEDS_MULTIMODAL',reason:'IMAGE_REQUIRES_VISION_EXTRACTION',text:''};
  else r={status:'PENDING',reason:'UNSUPPORTED_FILE_TYPE',text:''};
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
