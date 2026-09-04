// Local-first, incremental repository index.
//
// Not an always-running platform: a content-hash cache under
// .agent-sdlc/index/ plus deterministic per-file extraction. Re-indexing a
// clean tree re-reads nothing.
//
// Capability tiers, most authoritative first:
//
//   LSP_OR_COMPILER  a language server / compiler index (not bundled; detected)
//   LANGUAGE_PARSER  a real parser for the language (not bundled; detected)
//   DETERMINISTIC_SYNTAX  the tier implemented here — regex/line extraction
//   LLM_INFERENCE    only for relationships the tiers above cannot resolve
//
// This module reports the tier it actually used. It never claims a higher one.
import fs from 'node:fs';
import path from 'node:path';
import {ensureDir,git,gitSha,normalizeText,now,readJson,sha256,writeJson} from './util.mjs';
import {stateDir} from './store.mjs';

export const CAPABILITY_TIERS=['LSP_OR_COMPILER','LANGUAGE_PARSER','DETERMINISTIC_SYNTAX','LLM_INFERENCE'];
export const IMPLEMENTED_TIER='DETERMINISTIC_SYNTAX';

const indexDir=projectRoot=>path.join(stateDir(projectRoot),'index');
const indexPath=projectRoot=>path.join(indexDir(projectRoot),'repo-index.json');

const LANG_BY_EXT={
  '.js':'javascript','.mjs':'javascript','.cjs':'javascript','.jsx':'javascript',
  '.ts':'typescript','.tsx':'typescript',
  '.py':'python','.go':'go','.java':'java','.rb':'ruby','.rs':'rust','.cs':'csharp','.php':'php','.kt':'kotlin',
  '.c':'c','.h':'c','.cpp':'cpp','.hpp':'cpp','.cc':'cpp','.cxx':'cpp',
  '.swift':'swift','.scala':'scala','.sh':'shell','.bash':'shell','.zsh':'shell',
  '.sql':'sql','.json':'json','.yml':'yaml','.yaml':'yaml','.md':'markdown'
};
const CODE_LANGS=new Set(['javascript','typescript','python','go','java','ruby','rust','csharp','php','kotlin','c','cpp','swift','scala','shell']);

const TEST_PATTERNS=[
  /(^|\/)tests?\//i,/(^|\/)__tests__\//,/(^|\/)spec\//i,
  /\.test\.[a-z]+$/i,/\.spec\.[a-z]+$/i,/_test\.[a-z]+$/i,/^test_[^/]*\.[a-z]+$/i,/\/test_[^/]*\.[a-z]+$/i
];
const MIGRATION_PATTERNS=[/(^|\/)migrations?\//i,/(^|\/)db\/migrate\//i,/(^|\/)alembic\//i];

export const languageOf=rel=>LANG_BY_EXT[path.extname(rel).toLowerCase()]||'other';
export const isTestPath=rel=>TEST_PATTERNS.some(p=>p.test(rel));
export const isMigrationPath=rel=>MIGRATION_PATTERNS.some(p=>p.test(rel));

/**
 * Module boundary for a path. The first path segment under a recognised source
 * root, or the top-level directory. Deliberately simple and predictable.
 */
export function moduleOf(rel){
  const parts=String(rel).replace(/\\/g,'/').split('/').filter(Boolean);
  if(parts.length<=1)return '(root)';
  const roots=new Set(['src','lib','app','pkg','internal','cmd','packages','services','apps','source']);
  if(roots.has(parts[0])&&parts.length>2)return `${parts[0]}/${parts[1]}`;
  if(roots.has(parts[0]))return parts[0];
  return parts[0];
}

// --- extraction -------------------------------------------------------------

const RX={
  javascript:{
    symbols:[
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*class\s+([A-Za-z_$][\w$]*)/gm
    ],
    exports:[
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s*\{([^}]*)\}/gm
    ],
    imports:[/^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/gm,/^\s*import\s*['"]([^'"]+)['"]/gm,/require\(\s*['"]([^'"]+)['"]\s*\)/gm]
  },
  python:{
    symbols:[/^\s*def\s+([A-Za-z_]\w*)/gm,/^\s*class\s+([A-Za-z_]\w*)/gm],
    exports:[/^def\s+([A-Za-z_]\w*)/gm,/^class\s+([A-Za-z_]\w*)/gm],
    imports:[/^\s*from\s+([\w.]+)\s+import/gm,/^\s*import\s+([\w.]+)/gm]
  },
  go:{
    symbols:[/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,/^\s*type\s+([A-Za-z_]\w*)/gm],
    exports:[/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm,/^type\s+([A-Z]\w*)/gm],
    imports:[/^\s*import\s+"([^"]+)"/gm,/^\s+"([^"]+)"$/gm]
  },
  java:{
    symbols:[/^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm],
    exports:[/^\s*public\s+(?:abstract\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/gm],
    imports:[/^\s*import\s+(?:static\s+)?([\w.]+);/gm]
  },
  ruby:{
    symbols:[/^\s*def\s+([A-Za-z_]\w*[!?]?)/gm,/^\s*class\s+([A-Z]\w*)/gm,/^\s*module\s+([A-Z]\w*)/gm],
    exports:[/^\s*def\s+([A-Za-z_]\w*[!?]?)/gm,/^\s*class\s+([A-Z]\w*)/gm,/^\s*module\s+([A-Z]\w*)/gm],
    imports:[/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm]
  },
  rust:{
    symbols:[/^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_]\w*)/gm,/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm],
    exports:[/^\s*pub\s+fn\s+([A-Za-z_]\w*)/gm,/^\s*pub\s+(?:struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm],
    imports:[/^\s*use\s+([^;]+);/gm]
  },
  csharp:{
    symbols:[/^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?(?:async\s+)?(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/gm,/^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?(?:async\s+)?(?:void|[A-Za-z_][\w<>\[\],?\s]*)\s+([A-Za-z_]\w*)\s*\(/gm],
    exports:[/^\s*public\s+(?:static\s+)?(?:class|interface|struct|record|enum)\s+([A-Za-z_]\w*)/gm],
    imports:[/^\s*using\s+([^;]+);/gm]
  },
  php:{
    symbols:[/^\s*(?:final\s+|abstract\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm,/^\s*(?:public|protected|private)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)/gm],
    exports:[/^\s*public\s+(?:static\s+)?function\s+([A-Za-z_]\w*)/gm,/^\s*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm],
    imports:[/^\s*(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/gm,/^\s*use\s+([^;]+);/gm]
  },
  kotlin:{
    symbols:[/^\s*(?:fun|class|interface|object|enum\s+class)\s+([A-Za-z_]\w*)/gm],
    exports:[/^\s*(?:public\s+)?(?:fun|class|interface|object|enum\s+class)\s+([A-Za-z_]\w*)/gm],
    imports:[/^\s*import\s+([\w.*]+)/gm]
  },
  c:{
    symbols:[
      /^\s*(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:[A-Za-z_][\w*]*\s+)+([A-Za-z_]\w*)\s*\([^)]*\)\s*[{;]/gm
    ],
    exports:[
      /^\s*(?:typedef\s+)?(?:struct|enum|union)\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:[A-Za-z_][\w*]*\s+)+([A-Za-z_]\w*)\s*\([^)]*\)\s*[{;]/gm
    ],
    imports:[/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm]
  },
  cpp:{
    symbols:[
      /^\s*(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:template\s*<[^>]*>\s*)?(?:[A-Za-z_][\w:*&<>\s]*?)\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:const)?\s*[{;]/gm
    ],
    exports:[
      /^\s*(?:class|struct|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:template\s*<[^>]*>\s*)?(?:[A-Za-z_][\w:*&<>\s]*?)\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:const)?\s*[{;]/gm
    ],
    imports:[/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm,/^\s*import\s+([\w.:]+);/gm]
  },
  swift:{
    symbols:[
      /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?(?:protocol|struct|class|enum|actor)\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+)?func\s+([A-Za-z_]\w*)/gm
    ],
    exports:[
      /^\s*(?:public\s+|open\s+)(?:protocol|struct|class|enum|actor)\s+([A-Za-z_]\w*)/gm,
      /^\s*(?:public\s+|open\s+)func\s+([A-Za-z_]\w*)/gm
    ],
    imports:[/^\s*import\s+([A-Za-z_]\w*)/gm]
  },
  scala:{
    symbols:[
      /^\s*(?:def|class|object|trait|enum|case\s+class)\s+([A-Za-z_]\w*)/gm
    ],
    exports:[
      /^\s*(?:def|class|object|trait|enum|case\s+class)\s+([A-Za-z_]\w*)/gm
    ],
    imports:[/^\s*import\s+([\w._]+)/gm]
  },
  shell:{
    symbols:[
      /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/gm,
      /^\s*function\s+([A-Za-z_][\w-]*)/gm
    ],
    exports:[
      /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/gm,
      /^\s*function\s+([A-Za-z_][\w-]*)/gm
    ],
    imports:[/^\s*(?:\.|source)\s+([^\s;]+)/gm]
  }
};
RX.typescript={
  symbols:[...RX.javascript.symbols,/^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm],
  exports:[...RX.javascript.exports,/^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm],
  imports:RX.javascript.imports
};

// Identifier collection: a declared symbol or export name.
const collect=(text,patterns)=>{
  const out=new Set();
  for(const rx of patterns||[]){
    rx.lastIndex=0;
    let m;
    while((m=rx.exec(text))!==null){
      for(const part of String(m[1]||'').split(',')){
        const name=part.trim().split(/\s+as\s+/)[0].trim();
        if(name&&/^[A-Za-z_$][\w$.]*$/.test(name))out.add(name);
      }
    }
  }
  return [...out].sort();
};

// Import specifiers are paths, not identifiers: `./refund-repository.js` and
// `../../src/a.js` are valid and must survive collection.
const collectSpecifiers=(text,patterns)=>{
  const out=new Set();
  for(const rx of patterns||[]){
    rx.lastIndex=0;
    let m;
    while((m=rx.exec(text))!==null){
      const spec=String(m[1]||'').trim();
      if(spec&&!/\s/.test(spec))out.add(spec);
    }
  }
  return [...out].sort();
};

// HTTP route declarations across the common frameworks, deterministically.
const ROUTE_PATTERNS=[
  /\b(?:app|router|server|api)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]?([^'"`)]*)['"`]?\s*\)/g,
  /@(?:app|router|blueprint)\.route\s*\(\s*['"`]([^'"`]+)['"`](?:[^)]*methods\s*=\s*\[([^\]]*)\])?/gi,
  /\brouter\.(?:Handle|HandleFunc)\s*\(\s*['"`]([^'"`]+)['"`]/g,
  /@(?:RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping)\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g
];
function extractRoutes(text){
  const out=new Set();
  for(const rx of ROUTE_PATTERNS){
    rx.lastIndex=0;let m;
    while((m=rx.exec(text))!==null){
      const a=m[1]||'',b=m[2]||'';
      const method=/^(get|post|put|patch|delete|head|options)$/i.test(a)?a.toUpperCase():null;
      const route=method?b:a;
      if(route&&route.startsWith('/'))out.add(method?`${method} ${route}`:route);
    }
  }
  return [...out].sort();
}

// Data entities: SQL DDL plus the common ORM table declarations.
const ENTITY_PATTERNS=[
  /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([\w.]+)[`"\]]?/gi,
  /alter\s+table\s+[`"[]?([\w.]+)[`"\]]?/gi,
  /drop\s+table\s+(?:if\s+exists\s+)?[`"[]?([\w.]+)[`"\]]?/gi,
  /__tablename__\s*=\s*['"]([\w.]+)['"]/g,
  /@Table\s*\(\s*name\s*=\s*['"]([\w.]+)['"]/g,
  /\btable\s*:\s*['"]([\w.]+)['"]/g
];
function extractEntities(text){
  const out=new Set();
  for(const rx of ENTITY_PATTERNS){
    rx.lastIndex=0;let m;
    while((m=rx.exec(text))!==null)if(m[1])out.add(m[1].toLowerCase());
  }
  return [...out].sort();
}

// Event/message contracts: publish/subscribe topic and event-name literals.
const EVENT_PATTERNS=[
  /\b(?:publish|emit|dispatch|produce|send)\s*\(\s*['"`]([A-Za-z][\w.:-]{2,})['"`]/g,
  /\b(?:subscribe|on|consume|handle)\s*\(\s*['"`]([A-Za-z][\w.:-]{2,})['"`]/g,
  /\b(?:topic|queue|event_name|eventType)\s*[:=]\s*['"`]([A-Za-z][\w.:-]{2,})['"`]/g
];
function extractEvents(text){
  const out=new Set();
  for(const rx of EVENT_PATTERNS){
    rx.lastIndex=0;let m;
    while((m=rx.exec(text))!==null)if(m[1])out.add(m[1]);
  }
  return [...out].sort();
}

function extractFile(rel,text){
  const language=languageOf(rel);
  const rx=RX[language];
  const test=isTestPath(rel);
  return {
    path:rel,
    language,
    module:moduleOf(rel),
    lines:text.split('\n').length,
    is_test:test,
    is_migration:isMigrationPath(rel),
    symbols:rx?collect(text,rx.symbols):[],
    exports:rx?collect(text,rx.exports):[],
    imports:rx?collectSpecifiers(text,rx.imports):[],
    // Route/entity/event extraction is language-independent by design.
    routes:CODE_LANGS.has(language)?extractRoutes(text):[],
    entities:extractEntities(text),
    events:CODE_LANGS.has(language)?extractEvents(text):[],
    // Tests reference the symbols they exercise; that is the mapping signal.
    referenced:test&&rx?collect(text,[/\b([A-Z][A-Za-z0-9_]{2,})\b/g]):[]
  };
}

/** Detect whether a more authoritative tier is available. Honest, not hopeful. */
export function detectCapability(projectRoot){
  const has=rel=>fs.existsSync(path.join(projectRoot,rel));
  const signals={
    typescript_config:has('tsconfig.json'),
    go_module:has('go.mod'),
    python_project:has('pyproject.toml'),
    maven_or_gradle:has('pom.xml')||has('build.gradle')||has('build.gradle.kts')
  };
  return {
    tier:IMPLEMENTED_TIER,
    tiers:CAPABILITY_TIERS,
    // These would enable a higher tier; nothing here claims one is in use.
    higher_tier_signals:signals,
    lsp_available:false,
    language_parser_available:false,
    llm_inference_used:false,
    note:'deterministic syntax extraction only; a higher tier would need an external index this harness does not bundle'
  };
}

/** Files git knows about, honouring .gitignore for free. */
export function trackedFiles(projectRoot){
  const r=git(['ls-files'],projectRoot);
  if(r.code!==0)return [];
  return r.stdout.split('\n').map(s=>s.trim()).filter(Boolean);
}

/** Tracked files with git blob SHA: mode, blobSha, stage. */
export function trackedEntries(projectRoot){
  const r=git(['ls-files','-s'],projectRoot);
  if(r.code!==0)return new Map();
  const map=new Map();
  for(const line of r.stdout.split('\n')){
    const l=line.trim();
    if(!l)continue;
    const parts=l.split(/\t/);
    if(parts.length<2)continue;
    const meta=parts[0].split(/\s+/);
    const rel=parts.slice(1).join('\t').trim();
    if(meta.length>=2){
      map.set(rel,{mode:meta[0],blob_sha:meta[1],stage:meta[2]||'0'});
    }
  }
  return map;
}

const SKIP_DIR=/(^|\/)(node_modules|\.git|dist|build|out|coverage|vendor|\.agent-sdlc|__pycache__|\.venv)\//;
const MAX_FILE_BYTES=512*1024;

/**
 * Build or refresh the index. Incremental: a file whose blob hash or content
 * hash is unchanged keeps its cached entry and is not re-parsed or re-read.
 */
export function buildIndex(projectRoot,{force=false,maxFiles=20000}={}){
  const cached=!force&&fs.existsSync(indexPath(projectRoot))?readJson(indexPath(projectRoot),null):null;
  const previous=new Map((cached?.files||[]).map(f=>[f.path,f]));
  const entries=trackedEntries(projectRoot);
  const fileList=entries.size?[...entries.keys()]:trackedFiles(projectRoot);
  // SKIP_DIR first, then the cap. The other order spent the budget on files
  // that are dropped a line later: `git ls-files` is sorted, and a committed
  // dist/ (published JS packages, browser extensions) or vendor/ (Go) sorts
  // before src/, so a repository well under maxFiles could index nothing at
  // all. It also made the counts describe the wrong set -- `omitted_files`
  // and `is_truncated` were reporting never-indexable files as dropped work.
  const indexable=fileList.filter(rel=>!SKIP_DIR.test(`/${rel}/`));
  const excludedDirs=fileList.length-indexable.length;
  const totalDiscovered=indexable.length;
  const omittedFiles=Math.max(0,totalDiscovered-maxFiles);
  const isTruncated=omittedFiles>0;
  const files=[];let reused=0,parsed=0,skipped=excludedDirs,truncated=0;
  for(const rel of indexable.slice(0,maxFiles)){
    const abs=path.join(projectRoot,rel);
    let stat;try{stat=fs.statSync(abs);}catch{skipped++;continue;}
    if(!stat.isFile()){skipped++;continue;}
    const entry=entries.get(rel);
    const blobSha=entry?.blob_sha||null;
    const prev=previous.get(rel);

    // Explicitly record oversized files with truncation flag rather than dropping silently.
    if(stat.size>MAX_FILE_BYTES){
      files.push({
        path:rel,
        language:languageOf(rel),
        module:moduleOf(rel),
        lines:0,
        size:stat.size,
        is_test:isTestPath(rel),
        is_migration:isMigrationPath(rel),
        symbols:[],exports:[],imports:[],routes:[],entities:[],events:[],referenced:[],
        sha256:null,blob_sha:blobSha,
        truncated:true,is_truncated:true
      });
      truncated++;
      continue;
    }

    // Blob-SHA reuse: if git blob SHA matches cached record, reuse without reading disk.
    if(prev&&blobSha&&prev.blob_sha===blobSha&&!prev.truncated){
      files.push(prev);reused++;continue;
    }

    // Normalized before hashing so a file digest identifies content, not the
    // line endings a given platform checked out.
    let text;try{text=normalizeText(fs.readFileSync(abs,'utf8'));}catch{skipped++;continue;}
    const hash=sha256(text);
    if(prev&&prev.sha256===hash&&!prev.truncated){
      if(!prev.blob_sha&&blobSha)prev.blob_sha=blobSha;
      files.push(prev);reused++;continue;
    }
    files.push({...extractFile(rel,text),sha256:hash,blob_sha:blobSha,size:stat.size,truncated:false,is_truncated:false});
    parsed++;
  }
  const index={
    schema:'agent-sdlc/repo-index/v1',
    project_root:projectRoot,
    revision:gitSha(projectRoot),
    capability:detectCapability(projectRoot),
    is_truncated:isTruncated,
    counts:{
      files:files.length,
      total_discovered:totalDiscovered,
      omitted_files:omittedFiles,
      parsed,
      reused,
      skipped:skipped+omittedFiles,
      truncated,
      symbols:files.reduce((a,f)=>a+(f.symbols||[]).length,0),
      tests:files.filter(f=>f.is_test).length,
      migrations:files.filter(f=>f.is_migration).length
    },
    files,
    built_at:now()
  };
  ensureDir(indexDir(projectRoot));
  writeJson(indexPath(projectRoot),index);
  return index;
}

export function loadIndex(projectRoot,{build=true}={}){
  const p=indexPath(projectRoot);
  if(fs.existsSync(p)){
    const idx=readJson(p,null);
    if(idx&&idx.schema==='agent-sdlc/repo-index/v1')return idx;
  }
  return build?buildIndex(projectRoot):null;
}

/** True when the index no longer matches the working revision or working tree is dirty. */
export function indexStale(projectRoot,index=null){
  const idx=index||loadIndex(projectRoot,{build:false});
  if(!idx)return {stale:true,reason:'NO_INDEX'};
  const rev=gitSha(projectRoot);
  if(idx.revision!==rev)return {stale:true,reason:'REVISION_CHANGED',indexed:idx.revision,current:rev};
  // Untracked files included: a module the task just wrote is exactly what the
  // index does not describe, and `--untracked-files=no` reported such a tree as
  // current. `.agent-sdlc/` is dropped because it is the harness's own state --
  // a project that has not gitignored it would otherwise never see a fresh
  // index again. .gitignore is honoured, so build output stays out.
  const dirty=git(['status','--porcelain','--untracked-files=all'],projectRoot);
  if(dirty.code===0&&dirty.stdout.trim()){
    const changed=dirty.stdout.split('\n').map(s=>s.trim()).filter(Boolean)
      .filter(l=>!/^\?\?\s+\.agent-sdlc\//.test(l));
    if(changed.length)return {stale:true,reason:'DIRTY_WORKING_TREE',dirty_count:changed.length,dirty_files:changed.slice(0,20)};
  }
  return {stale:false,reason:null};
}
