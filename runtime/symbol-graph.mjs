// Symbol and dependency graph derived from the repository index.
//
// Everything here is a deterministic projection of runtime/repo-index.mjs: no
// network, no model, no hidden state. Import specifiers are resolved
// structurally (relative paths first, then module-name matching), and every
// unresolved edge is reported rather than guessed away.
import path from 'node:path';
import {loadIndex,moduleOf} from './repo-index.mjs';

const arr=x=>Array.isArray(x)?x:[];
const norm=p=>String(p||'').replace(/\\/g,'/').replace(/^\.\//,'');
const stripExt=p=>norm(p).replace(/\.(m|c)?[jt]sx?$/,'').replace(/\.py$/,'').replace(/\/index$/,'');

/**
 * Resolve one import specifier to an indexed file.
 * Relative specifiers resolve by path; bare specifiers resolve by module or
 * basename match. External packages resolve to null, which is correct, not a
 * failure — and they are counted separately from genuinely unresolved edges.
 */
export function resolveImport(fromPath,spec,byStripped,byBasename){
  // Keep the leading "./" here: `norm` strips it, and a specifier that no
  // longer looks relative gets misclassified as an external package.
  const s=String(spec||'').replace(/\\/g,'/');
  if(s.startsWith('.')){
    const target=stripExt(path.posix.normalize(path.posix.join(path.posix.dirname(norm(fromPath)),s)));
    return {resolved:byStripped.get(target)||null,kind:'relative'};
  }
  // Python-style dotted module, or a bare path-like specifier.
  const dotted=s.includes('/')?s:s.split('.').join('/');
  const hit=byStripped.get(stripExt(dotted))
    ||byStripped.get(stripExt(`src/${dotted}`))
    ||byBasename.get(s.split(/[/.]/).pop());
  return {resolved:hit||null,kind:hit?'module':'external'};
}

/** Build the file-level dependency graph plus a symbol location table. */
export function buildSymbolGraph(projectRoot,{index=null}={}){
  const idx=index||loadIndex(projectRoot);
  const files=arr(idx?.files);
  const byStripped=new Map();
  const byBasename=new Map();
  for(const f of files){
    byStripped.set(stripExt(f.path),f.path);
    const base=path.posix.basename(stripExt(f.path));
    if(!byBasename.has(base))byBasename.set(base,f.path);
  }

  const edges=[];const external=new Set();const unresolved=[];
  for(const f of files){
    for(const spec of arr(f.imports)){
      const {resolved,kind}=resolveImport(f.path,spec,byStripped,byBasename);
      if(resolved&&resolved!==f.path)edges.push({from:f.path,to:resolved,specifier:spec});
      else if(kind==='external')external.add(spec);
      else if(!resolved)unresolved.push({from:f.path,specifier:spec});
    }
  }

  const dependents=new Map();const dependencies=new Map();
  for(const e of edges){
    if(!dependents.has(e.to))dependents.set(e.to,new Set());
    dependents.get(e.to).add(e.from);
    if(!dependencies.has(e.from))dependencies.set(e.from,new Set());
    dependencies.get(e.from).add(e.to);
  }

  // A symbol may legitimately exist in several files; keep every location.
  const symbols=new Map();
  for(const f of files){
    for(const name of arr(f.symbols)){
      if(!symbols.has(name))symbols.set(name,[]);
      symbols.get(name).push({path:f.path,exported:arr(f.exports).includes(name),module:f.module,is_test:f.is_test});
    }
  }

  return {
    schema:'agent-sdlc/symbol-graph/v1',
    revision:idx?.revision??null,
    capability:idx?.capability??null,
    file_count:files.length,
    edge_count:edges.length,
    edges,
    external_dependencies:[...external].sort(),
    unresolved_imports:unresolved,
    symbols,
    dependents,
    dependencies,
    files:new Map(files.map(f=>[f.path,f]))
  };
}

/** Transitive dependents of a file, bounded by depth. */
export function dependentClosure(graph,filePath,{maxDepth=3}={}){
  const start=norm(filePath);
  const seen=new Map();
  let frontier=[start];
  for(let depth=1;depth<=maxDepth&&frontier.length;depth++){
    const next=[];
    for(const p of frontier){
      for(const dep of graph.dependents.get(p)||[]){
        if(seen.has(dep)||dep===start)continue;
        seen.set(dep,depth);
        next.push(dep);
      }
    }
    frontier=next;
  }
  return [...seen.entries()].map(([path,depth])=>({path,depth})).sort((a,b)=>a.depth-b.depth||a.path.localeCompare(b.path));
}

/**
 * Tests covering a symbol, ranked by how the link was established. Naming and
 * import evidence beat a bare textual reference, and the reason is reported so
 * a weak link is visible as a weak link.
 */
export function testsForSymbol(graph,symbolName){
  const locations=graph.symbols.get(symbolName)||[];
  const definingFiles=new Set(locations.filter(l=>!l.is_test).map(l=>l.path));
  const out=[];
  for(const [p,f] of graph.files){
    if(!f.is_test)continue;
    const reasons=[];
    if(arr(f.referenced).includes(symbolName)||arr(f.symbols).includes(symbolName))reasons.push('REFERENCES_SYMBOL');
    for(const dep of graph.dependencies.get(p)||[])if(definingFiles.has(dep))reasons.push('IMPORTS_DEFINING_FILE');
    const base=path.posix.basename(stripExt(p)).toLowerCase().replace(/(^test_|[._]test$|[._]spec$)/g,'');
    for(const d of definingFiles){
      if(base&&base===path.posix.basename(stripExt(d)).toLowerCase())reasons.push('NAME_MATCHES_DEFINING_FILE');
    }
    if(reasons.length)out.push({path:p,reasons:[...new Set(reasons)],strength:reasons.includes('IMPORTS_DEFINING_FILE')?'STRONG':(reasons.includes('NAME_MATCHES_DEFINING_FILE')?'MEDIUM':'WEAK')});
  }
  const rank={STRONG:0,MEDIUM:1,WEAK:2};
  return out.sort((a,b)=>rank[a.strength]-rank[b.strength]||a.path.localeCompare(b.path));
}

/** Tests whose import closure reaches any of the given files. */
export function testsForFiles(graph,filePaths,{maxDepth=3}={}){
  const targets=new Set(arr(filePaths).map(norm));
  const out=[];
  for(const [p,f] of graph.files){
    if(!f.is_test)continue;
    if(targets.has(p)){out.push({path:p,depth:0,reason:'IS_TARGET'});continue;}
    let found=null;
    let frontier=[p];const seen=new Set([p]);
    for(let depth=1;depth<=maxDepth&&frontier.length&&!found;depth++){
      const next=[];
      for(const cur of frontier){
        for(const dep of graph.dependencies.get(cur)||[]){
          if(targets.has(dep)){found={path:p,depth,reason:'IMPORT_CLOSURE'};break;}
          if(!seen.has(dep)){seen.add(dep);next.push(dep);}
        }
        if(found)break;
      }
      frontier=next;
    }
    if(found)out.push(found);
  }
  return out.sort((a,b)=>a.depth-b.depth||a.path.localeCompare(b.path));
}

/** Files in a module boundary, and the boundary's public surface. */
export function moduleBoundary(graph,targetPath){
  const mod=moduleOf(norm(targetPath));
  const files=[...graph.files.values()].filter(f=>f.module===mod).map(f=>f.path).sort();
  const inbound=new Set();const outbound=new Set();
  for(const e of graph.edges){
    const fromIn=files.includes(e.from),toIn=files.includes(e.to);
    if(toIn&&!fromIn)inbound.add(e.from);
    if(fromIn&&!toIn)outbound.add(e.to);
  }
  return {
    module:mod,files,
    inbound_dependents:[...inbound].sort(),
    outbound_dependencies:[...outbound].sort(),
    public_symbols:[...new Set(files.flatMap(p=>arr(graph.files.get(p)?.exports)))].sort()
  };
}
