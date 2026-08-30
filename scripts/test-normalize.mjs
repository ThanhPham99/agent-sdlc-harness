#!/usr/bin/env node
// Input normalization suite.
//
// normalizeInput is where untrusted material enters the harness: a requirement
// document, a spreadsheet, a PDF someone attached to a ticket. The coverage
// report put runtime/normalize.mjs at 22%, the lowest of any executed module,
// and the parsers had never been driven by a test at all.
//
// Fixtures are built with the repository's own dependency-free zip writer, so
// this needs no external tooling beyond the `unzip` the parser already shells
// out to; where a tool is absent the parser's own PENDING status is asserted
// instead of the parse result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {zipDir} from './archive.mjs';
import {normalizeInput,MAX_EXTRACTED_BYTES} from '../runtime/normalize.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-normalize-'));
const {test,assert,finish}=createSuite('agent-sdlc/normalize-validation/v1','NORMALIZE-VALIDATION.json');
const has=bin=>{const r=spawnSync(bin,['--help'],{encoding:'utf8',timeout:3000});return !r.error;};
const HAS_UNZIP=has('unzip');
const HAS_PDFTOTEXT=has('pdftotext');

let seq=0;
function write(name,content){
  const p=path.join(TMP,`${seq++}-${name}`);
  fs.writeFileSync(p,content);
  return p;
}
/** An OOXML container: entries live at the archive root, not under a folder. */
function ooxml(ext,files){
  const dir=fs.mkdtempSync(path.join(TMP,'pkg-'));
  for(const [rel,body] of Object.entries(files)){
    const abs=path.join(dir,rel);
    fs.mkdirSync(path.dirname(abs),{recursive:true});
    fs.writeFileSync(abs,body);
  }
  const zip=path.join(TMP,`${seq++}-fixture${ext}`);
  zipDir(dir,zip,{prefix:''});
  return zip;
}
const docx=body=>ooxml('.docx',{'word/document.xml':body});
const sheet=body=>ooxml('.xlsx',{'xl/worksheets/sheet1.xml':body});
const row=cells=>`<worksheet><sheetData><row>${cells}</row></sheetData></worksheet>`;
const inlineCell=(ref,text)=>`<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

// --- plain text ------------------------------------------------------------
test('text-file-is-normalized-with-provenance',()=>{
  const out=normalizeInput(write('req.md','# Refunds\n\nMust round half to even.\n'));
  if(out.status!=='NORMALIZED')throw new Error(out.status);
  if(!out.markdown.includes('Must round half to even'))throw new Error('body lost');
  if(out.source_sha256.length!==64)throw new Error('no source digest');
  if(!out.markdown.includes(`source_sha256: ${out.source_sha256}`))throw new Error('digest not in the header');
  if(out.source_bytes!==fs.statSync(out.source_file).size)throw new Error('byte count mismatch');
});
test('byte-order-mark-is-stripped',()=>{
  const out=normalizeInput(write('bom.txt',String.fromCharCode(0xFEFF)+'plain'));
  if(!out.markdown.trimEnd().endsWith('plain'))throw new Error(JSON.stringify(out.markdown.slice(-20)));
  if(out.markdown.includes(String.fromCharCode(0xFEFF)))throw new Error('BOM survived');
});
test('json-is-pretty-printed-and-invalid-json-is-passed-through',()=>{
  const ok=normalizeInput(write('a.json','{"b":1,"a":[2,3]}'));
  if(!ok.markdown.includes('"b": 1'))throw new Error('not re-indented');
  const bad=normalizeInput(write('b.json','{not json'));
  if(bad.status!=='NORMALIZED'||!bad.markdown.includes('{not json'))throw new Error('invalid JSON was not passed through');
});
test('unsupported-and-image-types-report-a-status-not-a-guess',()=>{
  const bin=normalizeInput(write('archive.bin','\u0000\u0001'));
  if(bin.status!=='PENDING'||bin.reason!=='UNSUPPORTED_FILE_TYPE')throw new Error(JSON.stringify(bin));
  const img=normalizeInput(write('scan.png','not really a png'));
  if(img.status!=='NEEDS_MULTIMODAL'||img.reason!=='IMAGE_REQUIRES_VISION_EXTRACTION')throw new Error(JSON.stringify(img));
  if(img.markdown.includes('not really a png'))throw new Error('image bytes leaked into the artifact');
});
test('oversized-input-is-refused-before-it-is-read',()=>{
  const p=write('big.txt','x'.repeat(4096));
  let refused=false;
  try{normalizeInput(p,{maxBytes:1024});}catch(e){refused=/exceeds maxBytes/.test(e.message);}
  if(!refused)throw new Error('a file over the cap was accepted');
});
test('a-directory-is-not-an-input',()=>{
  let refused=false;
  try{normalizeInput(TMP);}catch(e){refused=/must be a file/.test(e.message);}
  if(!refused)throw new Error('a directory was accepted as input');
});

// --- docx ------------------------------------------------------------------
test('docx-body-headers-and-footnotes-are-extracted-in-order',()=>{
  const f=ooxml('.docx',{
    'word/document.xml':'<w:p><w:t>Body one</w:t></w:p><w:p><w:t>Body two</w:t></w:p>',
    'word/header1.xml':'<w:p><w:t>Header text</w:t></w:p>',
    'word/footnotes.xml':'<w:p><w:t>Footnote text</w:t></w:p>'
  });
  const out=normalizeInput(f);
  if(out.status!=='NORMALIZED')throw new Error(JSON.stringify(out));
  for(const s of ['Body one','Body two','Header text','Footnote text'])
    if(!out.markdown.includes(s))throw new Error(`missing ${s}`);
  const order=['word/document.xml','word/header1.xml','word/footnotes.xml'].map(e=>out.markdown.indexOf(e));
  if(order.some(i=>i<0)||order[0]>order[1]||order[1]>order[2])throw new Error(`unexpected section order: ${order}`);
});
test('docx-markup-becomes-text-not-tags',()=>{
  const out=normalizeInput(docx('<w:p><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c &amp; d</w:t></w:p>'));
  if(/<w:/.test(out.markdown))throw new Error('markup survived');
  if(!out.markdown.includes('a\tb'))throw new Error('tab not converted');
  if(!out.markdown.includes('c & d'))throw new Error('entity not decoded');
});
test('docx-with-no-text-part-is-pending-not-empty-success',()=>{
  const out=normalizeInput(ooxml('.docx',{'docProps/app.xml':'<Properties/>'}));
  if(out.status!=='PENDING'||out.reason!=='DOCX_TEXT_NOT_FOUND')throw new Error(JSON.stringify(out));
});
test('character-reference-outside-unicode-is-left-as-text',()=>{
  // Regression: String.fromCodePoint threw RangeError out of the parser.
  for(const ref of ['&#1114112;','&#x110000;','&#99999999999999;']){
    const out=normalizeInput(docx(`<w:p><w:t>before ${ref} after</w:t></w:p>`));
    if(out.status!=='NORMALIZED')throw new Error(`${ref} -> ${out.status} ${out.reason}`);
    if(!out.markdown.includes(ref))throw new Error(`${ref} was not preserved literally`);
  }
  const valid=normalizeInput(docx('<w:p><w:t>&#65;&#x42;</w:t></w:p>'));
  if(!valid.markdown.includes('AB'))throw new Error('valid references stopped decoding');
});

test('a-docx-cannot-spend-an-unbounded-extraction-budget-across-many-parts',()=>{
  // The per-entry cap (unzip maxBuffer) bounds one part, not a document. A
  // container is free to declare hundreds of header/footer parts, and the
  // parser extracted every one of them: the input size limit says nothing
  // about what the archive expands to. Same class as MAX_COLUMNS -- a
  // dimension the format leaves open and the parser has to close.
  const parts={'word/document.xml':'<w:p><w:t>Body</w:t></w:p>'};
  const filler='<w:p><w:t>'+'z'.repeat(40*1024)+'</w:t></w:p>';
  for(let i=1;i<=400;i++)parts[`word/header${i}.xml`]=filler;
  const out=normalizeInput(ooxml('.docx',parts));
  // Whatever it returns, it must be bounded and it must say so rather than
  // quietly handing back a 16 MB requirement document.
  const bytes=Buffer.byteLength(out.markdown);
  if(bytes>MAX_EXTRACTED_BYTES+64*1024)throw new Error(`extracted ${bytes} bytes from a small archive`);
  if(!out.markdown.includes('Body'))throw new Error('the real body was dropped');
  if(out.reason!=='EXTRACTION_BUDGET_EXCEEDED')throw new Error(`truncation not reported: ${JSON.stringify({status:out.status,reason:out.reason})}`);
});

test('an-xlsx-cannot-spend-an-unbounded-extraction-budget-across-many-sheets',()=>{
  const parts={};
  const rows=Array.from({length:150},(_,i)=>`<row>${inlineCell(`A${i+1}`,'y'.repeat(400))}</row>`).join('');
  for(let i=1;i<=200;i++)parts[`xl/worksheets/sheet${i}.xml`]=`<worksheet><sheetData>${rows}</sheetData></worksheet>`;
  const out=normalizeInput(ooxml('.xlsx',parts));
  const bytes=Buffer.byteLength(out.markdown);
  if(bytes>MAX_EXTRACTED_BYTES+64*1024)throw new Error(`extracted ${bytes} bytes from a small archive`);
  if(out.reason!=='EXTRACTION_BUDGET_EXCEEDED')throw new Error(`truncation not reported: ${JSON.stringify({status:out.status,reason:out.reason})}`);
});

test('a-document-inside-the-budget-is-not-marked-truncated',()=>{
  const out=normalizeInput(docx('<w:p><w:t>small enough</w:t></w:p>'));
  if(out.status!=='NORMALIZED'||out.reason)throw new Error(JSON.stringify({status:out.status,reason:out.reason}));
});

// --- xlsx ------------------------------------------------------------------
test('xlsx-shared-and-inline-strings-become-a-table',()=>{
  const f=ooxml('.xlsx',{
    'xl/sharedStrings.xml':'<sst><si><t>Item</t></si><si><t>Amount</t></si><si><t>Refund</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>'+
      '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'+
      '<row><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row>'+
      '</sheetData></worksheet>'
  });
  const out=normalizeInput(f);
  if(out.status!=='NORMALIZED')throw new Error(JSON.stringify(out));
  if(!out.markdown.includes('| Item | Amount |'))throw new Error('header row missing');
  if(!out.markdown.includes('| Refund | 12.5 |'))throw new Error('body row missing');
});
test('xlsx-sheet-names-come-from-the-workbook-relationships',()=>{
  const f=ooxml('.xlsx',{
    'xl/workbook.xml':'<workbook><sheets><sheet name="Q3 Refunds" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':row(inlineCell('A1','only'))
  });
  const out=normalizeInput(f);
  if(!out.markdown.includes('## Sheet: Q3 Refunds'))throw new Error(out.markdown.slice(0,300));
});
test('a-cell-reference-past-the-column-limit-is-dropped',()=>{
  // Regression: r="ZZZZZ1" padded the row to 12.3M cells and turned a 1 KB
  // workbook into a 111 MB artifact; one letter more threw RangeError.
  for(const ref of ['XFE1','ZZZ1','ZZZZZ1','ZZZZZZZZ1']){
    const out=normalizeInput(sheet(row(inlineCell('A1','kept')+inlineCell(ref,'dropped'))));
    if(out.markdown.length>4096)throw new Error(`${ref} produced ${out.markdown.length} bytes`);
    if(out.markdown.includes('dropped'))throw new Error(`${ref} was honoured`);
    if(!out.markdown.includes('kept'))throw new Error(`${ref} discarded the valid cell too`);
  }
});
test('the-last-legal-column-still-works',()=>{
  const out=normalizeInput(sheet(row(inlineCell('A1','first')+inlineCell('XFD1','last'))));
  if(out.status!=='NORMALIZED')throw new Error(JSON.stringify(out));
  if(!out.markdown.includes('last'))throw new Error('XFD was rejected');
});
test('xlsx-cell-text-cannot-forge-table-columns',()=>{
  const out=normalizeInput(sheet(row(inlineCell('A1','a | b')+inlineCell('B1','c'))));
  if(!out.markdown.includes('a \\| b'))throw new Error('pipe not escaped');
});
test('a-sheet-with-no-cells-is-pending',()=>{
  const out=normalizeInput(sheet('<worksheet><sheetData/></worksheet>'));
  if(out.status!=='PENDING'||out.reason!=='XLSX_TEXT_NOT_FOUND')throw new Error(JSON.stringify(out));
});
test('an-unsafe-relationship-target-is-refused',()=>{
  // The sheet target is attacker controlled; a traversal or option-looking name
  // must never reach the unzip argv.
  for(const target of ['../../../etc/passwd','-p']){
    const f=ooxml('.xlsx',{
      'xl/workbook.xml':'<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':`<Relationships><Relationship Id="rId1" Target="${target}"/></Relationships>`,
      'xl/worksheets/sheet1.xml':row(inlineCell('A1','fallback sheet'))
    });
    const out=normalizeInput(f);
    if(out.status==='NORMALIZED'&&/etc\/passwd|root:/.test(out.markdown))throw new Error(`${target} was followed`);
    if(!['NORMALIZED','PENDING'].includes(out.status))throw new Error(`${target} -> ${out.status}`);
  }
});

// --- pdf -------------------------------------------------------------------
test('pdf-without-extractable-text-is-not-silently-empty',()=>{
  if(!HAS_PDFTOTEXT)return 'SKIP';
  // A file that is not a PDF at all: the extractor must report, not invent.
  const out=normalizeInput(write('broken.pdf','%PDF-1.4 truncated'));
  if(!['PENDING','NEEDS_MULTIMODAL'].includes(out.status))throw new Error(JSON.stringify(out));
  if(out.markdown.includes('truncated'))throw new Error('raw bytes leaked as extracted text');
});

// --- contract --------------------------------------------------------------
test('every-result-carries-a-status-and-a-provenance-header',()=>{
  const inputs=[write('c.md','x'),write('d.bin','x'),write('e.png','x'),docx('<w:p><w:t>y</w:t></w:p>')];
  for(const p of inputs){
    const out=normalizeInput(p);
    if(!['NORMALIZED','PENDING','NEEDS_MULTIMODAL'].includes(out.status))throw new Error(`${p}: ${out.status}`);
    if(out.schema!=='agent-sdlc/normalized-input/v1')throw new Error('wrong schema');
    if(!out.markdown.startsWith('# Normalized Input'))throw new Error('no provenance header');
    if(!out.markdown.includes(`normalization_status: ${out.status}`))throw new Error('status absent from the header');
  }
});

finish({unzip_available:HAS_UNZIP,pdftotext_available:HAS_PDFTOTEXT});
