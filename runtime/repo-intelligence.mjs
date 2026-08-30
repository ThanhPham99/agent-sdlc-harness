// Repository intelligence: the provider-neutral query surface over the index
// and symbol graph.
//
// Its job is to make the task context compiler stop guessing. Instead of
// "search the repo for anything about refunds", the compiler asks for the
// minimal change surface and gets exact symbols, files, tests, interfaces and
// data entities — with the capability tier that produced them attached, so a
// weak answer is visibly weak.
import path from 'node:path';
import {loadIndex,buildIndex,indexStale,detectCapability,IMPLEMENTED_TIER,moduleOf} from './repo-index.mjs';
import {buildSymbolGraph,dependentClosure,testsForSymbol,testsForFiles,moduleBoundary} from './symbol-graph.mjs';
import {git} from './util.mjs';

const arr=x=>Array.isArray(x)?x:[];
const norm=p=>String(p||'').replace(/\\/g,'/').replace(/^\.\//,'');
const graphCache=new Map();

/** Open (and cache per call site) the intelligence view of a project. */
export function openIntelligence(projectRoot,{refresh=false}={}){
  const index=refresh?buildIndex(projectRoot,{force:true}):loadIndex(projectRoot);
  const cacheKey=`${projectRoot}:${index?.revision||'no-rev'}:${index?.counts?.files||0}`;
  let graph;
  if(!refresh&&graphCache.has(cacheKey)){
    graph=graphCache.get(cacheKey);
  }else{
    graph=buildSymbolGraph(projectRoot,{index});
    graphCache.set(cacheKey,graph);
  }
  return {
    schema:'agent-sdlc/repo-intelligence/v1',
    project_root:projectRoot,
    revision:index?.revision??null,
    capability:index?.capability??detectCapability(projectRoot),
    stale:indexStale(projectRoot,index),
    counts:index?.counts??null,
    index,graph
  };
}

const withCapability=(intel,payload)=>({
  ...payload,
  capability_tier:intel.capability?.tier??IMPLEMENTED_TIER,
  revision:intel.revision
});

export function findSymbol(intel,name){
  return withCapability(intel,{
    query:'findSymbol',symbol:name,
    locations:intel.graph.symbols.get(name)||[]
  });
}

/** Files that reference a symbol: importers of its definition plus textual hits. */
export function findReferences(intel,name){
  const locations=intel.graph.symbols.get(name)||[];
  const definingFiles=locations.filter(l=>!l.is_test).map(l=>l.path);
  const importers=new Set();
  for(const d of definingFiles)for(const dep of intel.graph.dependents.get(d)||[])importers.add(dep);
  const textual=[];
  for(const [p,f] of intel.graph.files){
    if(definingFiles.includes(p))continue;
    if(arr(f.symbols).includes(name)||arr(f.referenced).includes(name))textual.push(p);
  }
  return withCapability(intel,{
    query:'findReferences',symbol:name,
    defined_in:definingFiles,
    importers:[...importers].sort(),
    textual_references:textual.sort(),
    // Structural importers are evidence; textual hits are candidates.
    confidence:importers.size?'STRUCTURAL':(textual.length?'TEXTUAL':'NONE')
  });
}

export function findTestsForSymbol(intel,name){
  return withCapability(intel,{query:'findTestsForSymbol',symbol:name,tests:testsForSymbol(intel.graph,name)});
}

export function findTestsForFiles(intel,paths,opts={}){
  return withCapability(intel,{query:'findTestsForFiles',paths:arr(paths).map(norm),tests:testsForFiles(intel.graph,paths,opts)});
}

export function findModuleBoundary(intel,targetPath){
  return withCapability(intel,{query:'findModuleBoundary',...moduleBoundary(intel.graph,targetPath)});
}

export function findDependents(intel,target,opts={}){
  return withCapability(intel,{query:'findDependents',target:norm(target),dependents:dependentClosure(intel.graph,target,opts)});
}

/** Public surface of the given paths: exported symbols plus HTTP routes. */
export function findPublicInterfaces(intel,paths){
  const set=new Set(arr(paths).map(norm));
  const rows=[];
  for(const [p,f] of intel.graph.files){
    if(set.size&&!set.has(p))continue;
    if(arr(f.exports).length||arr(f.routes).length){
      rows.push({path:p,module:f.module,exports:arr(f.exports),routes:arr(f.routes)});
    }
  }
  return withCapability(intel,{
    query:'findPublicInterfaces',
    files:rows.sort((a,b)=>a.path.localeCompare(b.path)),
    routes:[...new Set(rows.flatMap(r=>r.routes))].sort()
  });
}

/** Data entities and the migrations that touch them. */
export function findDataEntities(intel,paths=[]){
  const set=new Set(arr(paths).map(norm));
  const byEntity=new Map();
  for(const [p,f] of intel.graph.files){
    if(set.size&&!set.has(p))continue;
    for(const e of arr(f.entities)){
      if(!byEntity.has(e))byEntity.set(e,{entity:e,files:[],migrations:[]});
      byEntity.get(e).files.push(p);
      if(f.is_migration)byEntity.get(e).migrations.push(p);
    }
  }
  return withCapability(intel,{
    query:'findDataEntities',
    entities:[...byEntity.values()].sort((a,b)=>a.entity.localeCompare(b.entity))
  });
}

/** Event/message contracts and where they are produced or consumed. */
export function findEventContracts(intel,paths=[]){
  const set=new Set(arr(paths).map(norm));
  const byEvent=new Map();
  for(const [p,f] of intel.graph.files){
    if(set.size&&!set.has(p))continue;
    for(const e of arr(f.events)){
      if(!byEvent.has(e))byEvent.set(e,{event:e,files:[]});
      byEvent.get(e).files.push(p);
    }
  }
  return withCapability(intel,{query:'findEventContracts',events:[...byEvent.values()].sort((a,b)=>a.event.localeCompare(b.event))});
}

/** Recently changed paths, with a change count, from git history. */
export function findRecentChanges(intel,paths=[],{limit=50,since='30'}={}){
  const r=git(['log',`-${Number(limit)}`,'--name-only','--pretty=format:%H',`--since=${since} days ago`],intel.project_root);
  const counts=new Map();
  if(r.code===0){
    for(const line of r.stdout.split('\n')){
      const p=line.trim();
      if(!p||/^[0-9a-f]{7,40}$/.test(p))continue;
      counts.set(p,(counts.get(p)||0)+1);
    }
  }
  const set=new Set(arr(paths).map(norm));
  const rows=[...counts.entries()]
    .filter(([p])=>!set.size||set.has(p))
    .map(([path,changes])=>({path,changes}))
    .sort((a,b)=>b.changes-a.changes||a.path.localeCompare(b.path));
  return withCapability(intel,{query:'findRecentChanges',available:r.code===0,changed:rows});
}

// --- minimal change surface -------------------------------------------------

const STOP=new Set(['the','a','an','and','or','for','to','in','on','of','with','add','fix','update','make','support','implement','change','new','use','from','into','when','that','this','it','is','be','should','must','allow','ensure','so']);
function keywords(objective){
  return [...new Set(String(objective||'').toLowerCase().split(/[^a-z0-9_]+/).filter(w=>w.length>2&&!STOP.has(w)))];
}
const splitIdentifier=name=>String(name).replace(/([a-z0-9])([A-Z])/g,'$1 $2').split(/[^A-Za-z0-9]+/).map(s=>s.toLowerCase()).filter(Boolean);

/**
 * The bounded set of symbols, files, tests, interfaces and data entities an
 * objective plausibly touches — the answer that replaces a broad repo scan.
 *
 * Deterministic scoring: identifier-word matches on symbol names, then the
 * files that define them, then the dependent closure, then the tests that
 * cover those files. Everything reports why it is included.
 */
export function getMinimalChangeSurface(intel,objective,{maxSymbols=12,maxFiles=15,maxTests=10,dependentDepth=2}={}){
  const words=keywords(objective);
  const scored=[];
  for(const [name,locations] of intel.graph.symbols){
    const parts=splitIdentifier(name);
    const hits=words.filter(w=>parts.includes(w)||parts.some(p=>p.startsWith(w)&&w.length>=4));
    if(hits.length)scored.push({symbol:name,score:hits.length,matched:hits,locations});
  }
  scored.sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol));
  const symbols=scored.slice(0,maxSymbols);

  const seedFiles=[...new Set(symbols.flatMap(s=>s.locations.filter(l=>!l.is_test).map(l=>l.path)))];
  // Files whose own path words match, even when no symbol name did.
  const pathMatches=[...intel.graph.files.keys()]
    .filter(p=>!seedFiles.includes(p)&&!intel.graph.files.get(p).is_test)
    .filter(p=>{const parts=splitIdentifier(path.posix.basename(p));return words.some(w=>parts.includes(w));});
  const primary=[...new Set([...seedFiles,...pathMatches])].slice(0,maxFiles);

  const dependents=[...new Set(primary.flatMap(p=>dependentClosure(intel.graph,p,{maxDepth:dependentDepth}).map(d=>d.path)))]
    .filter(p=>!primary.includes(p));
  const tests=testsForFiles(intel.graph,primary).slice(0,maxTests);
  const interfaces=findPublicInterfaces(intel,primary);
  const entities=findDataEntities(intel,[...primary,...dependents]);
  const modules=[...new Set(primary.map(p=>moduleOf(p)))].sort();

  return withCapability(intel,{
    query:'getMinimalChangeSurface',
    objective:String(objective||''),
    keywords:words,
    symbols:symbols.map(s=>({symbol:s.symbol,score:s.score,matched:s.matched,paths:s.locations.map(l=>l.path)})),
    files:primary,
    dependent_files:dependents.slice(0,maxFiles),
    tests:tests.map(t=>t.path),
    modules,
    public_interfaces:interfaces.routes,
    exported_symbols:[...new Set(interfaces.files.flatMap(f=>f.exports))].sort().slice(0,40),
    data_entities:entities.entities.map(e=>e.entity),
    bounded:true,
    // When nothing matched, say so instead of returning the whole repository.
    empty_reason:symbols.length||primary.length?null:'NO_DETERMINISTIC_MATCH_BROADER_SEARCH_REQUIRED'
  });
}

/** One compact summary suitable for a task context package. */
export function changeSurfaceSummary(intel,objective,opts={}){
  const s=getMinimalChangeSurface(intel,objective,opts);
  return {
    capability_tier:s.capability_tier,
    revision:s.revision,
    symbols:s.symbols.map(x=>x.symbol),
    files:s.files,
    tests:s.tests,
    modules:s.modules,
    public_interfaces:s.public_interfaces,
    data_entities:s.data_entities,
    empty_reason:s.empty_reason
  };
}

/**
 * Find transitive dependency closure and blast radius for modified files or symbols.
 */
export function findTransitiveImpact(intel,{paths=[],symbols=[],maxDepth=10}={}){
  const normPaths=arr(paths).map(norm).filter(Boolean);
  const symbolLocations=arr(symbols).flatMap(s=>arr(intel.graph.symbols.get(s)).map(l=>l.path));
  const seeds=[...new Set([...normPaths,...symbolLocations])];

  const directDependents=new Set();
  const transitiveDependents=new Map();

  for(const seed of seeds){
    const closure=dependentClosure(intel.graph,seed,{maxDepth});
    for(const item of closure){
      if(!seeds.includes(item.path)){
        if(item.depth===1)directDependents.add(item.path);
        const existing=transitiveDependents.get(item.path);
        if(existing===undefined||item.depth<existing){
          transitiveDependents.set(item.path,item.depth);
        }
      }
    }
  }

  const sortedTransitive=[...transitiveDependents.entries()]
    .map(([p,depth])=>({path:p,depth,direct:directDependents.has(p)}))
    .sort((a,b)=>a.depth-b.depth||a.path.localeCompare(b.path));

  return withCapability(intel,{
    query:'findTransitiveImpact',
    seeds,
    direct_dependents:[...directDependents].sort(),
    transitive_dependents:sortedTransitive,
    total_impacted_files:sortedTransitive.length
  });
}

/**
 * Smart Test Selection: calculate exactly which tests need to run for modified files/symbols.
 */
export function findImpactedTests(intel,{paths=[],symbols=[],maxDepth=10}={}){
  const impact=findTransitiveImpact(intel,{paths,symbols,maxDepth});
  const allAffectedFiles=[...new Set([...impact.seeds,...impact.transitive_dependents.map(d=>d.path)])];

  const candidateTests=testsForFiles(intel.graph,allAffectedFiles,{maxDepth});
  const symbolTests=arr(symbols).flatMap(s=>testsForSymbol(intel.graph,s));

  const mergedTests=new Map();
  for(const t of candidateTests){
    mergedTests.set(t.path,{
      path:t.path,
      depth:t.depth,
      reason:t.reason||(impact.seeds.includes(t.path)?'MODIFIED_TEST':'TRANSITIVE_DEPENDENCY'),
      strength:t.depth===0?'STRONG':(t.depth===1?'STRONG':'MEDIUM')
    });
  }

  for(const st of symbolTests){
    if(!mergedTests.has(st.path)){
      mergedTests.set(st.path,{
        path:st.path,
        depth:1,
        reason:'SYMBOL_REFERENCE',
        strength:st.strength
      });
    }
  }

  const sortedTests=[...mergedTests.values()]
    .sort((a,b)=>{
      const rank={STRONG:0,MEDIUM:1,WEAK:2};
      return rank[a.strength]-rank[b.strength]||a.depth-b.depth||a.path.localeCompare(b.path);
    });

  const totalRepoTests=[...intel.graph.files.values()].filter(f=>f.is_test).length;
  const coverageRatio=totalRepoTests>0?(sortedTests.length/totalRepoTests):1;

  return withCapability(intel,{
    query:'findImpactedTests',
    modified_seeds:impact.seeds,
    impacted_files_count:allAffectedFiles.length,
    impacted_tests:sortedTests,
    impacted_tests_count:sortedTests.length,
    total_repo_tests:totalRepoTests,
    test_selection_ratio:Number(coverageRatio.toFixed(3)),
    recommended_test_files:sortedTests.map(t=>t.path)
  });
}

/**
 * Calculate graph centrality (in-degree, out-degree, PageRank score) for all repository files.
 * Identifies core hotspot modules that carry high blast radius across the codebase.
 */
export function calculateGraphCentrality(intel, { iterations = 20, dampingFactor = 0.85 } = {}) {
  const fileNodes = [...intel.graph.files.keys()];
  const n = fileNodes.length;
  if (n === 0) {
    return withCapability(intel, {
      query: 'calculateGraphCentrality',
      total_files: 0,
      critical_core_count: 0,
      critical_core_files: [],
      centrality_ranking: []
    });
  }

  const inDegreeMap = new Map();
  const outDegreeMap = new Map();
  const outgoingLinks = new Map();

  for (const f of fileNodes) {
    inDegreeMap.set(f, 0);
    outDegreeMap.set(f, 0);
    outgoingLinks.set(f, []);
  }

  for (const [src, deps] of intel.graph.dependencies) {
    outDegreeMap.set(src, arr(deps).length);
    outgoingLinks.set(src, arr(deps));
    for (const target of arr(deps)) {
      if (inDegreeMap.has(target)) {
        inDegreeMap.set(target, inDegreeMap.get(target) + 1);
      }
    }
  }

  let scores = new Map();
  for (const f of fileNodes) scores.set(f, 1 / n);

  for (let iter = 0; iter < iterations; iter++) {
    const nextScores = new Map();
    const baseRank = (1 - dampingFactor) / n;

    for (const f of fileNodes) nextScores.set(f, baseRank);

    for (const [src, targets] of outgoingLinks) {
      const rank = scores.get(src);
      if (targets.length > 0) {
        const share = (rank * dampingFactor) / targets.length;
        for (const target of targets) {
          if (nextScores.has(target)) {
            nextScores.set(target, nextScores.get(target) + share);
          }
        }
      } else {
        const share = (rank * dampingFactor) / n;
        for (const f of fileNodes) {
          nextScores.set(f, nextScores.get(f) + share);
        }
      }
    }
    scores = nextScores;
  }

  const ranking = fileNodes.map(f => {
    const score = Number((scores.get(f) || 0).toFixed(6));
    const inDegree = inDegreeMap.get(f) || 0;
    const outDegree = outDegreeMap.get(f) || 0;
    const fileMeta = intel.graph.files.get(f);
    return {
      path: f,
      module: fileMeta?.module || null,
      is_test: fileMeta?.is_test || false,
      pagerank_score: score,
      in_degree: inDegree,
      out_degree: outDegree,
      is_critical_core: false
    };
  }).sort((a, b) => b.pagerank_score - a.pagerank_score || b.in_degree - a.in_degree || a.path.localeCompare(b.path));

  const coreCutoff = Math.max(3, Math.ceil(n * 0.15));
  const coreFiles = [];

  ranking.forEach((r, idx) => {
    if (!r.is_test && (idx < coreCutoff || r.in_degree >= 5)) {
      r.is_critical_core = true;
      coreFiles.push(r.path);
    }
  });

  return withCapability(intel, {
    query: 'calculateGraphCentrality',
    total_files: n,
    critical_core_count: coreFiles.length,
    critical_core_files: coreFiles,
    centrality_ranking: ranking
  });
}

/**
 * Perform Blast Radius Analysis for proposed file changes.
 * Evaluates impact severity, touches on critical core modules, and affected dependent surface.
 */
export function getBlastRadiusAnalysis(intel, { paths = [], symbols = [], maxDepth = 5 } = {}) {
  const transitive = findTransitiveImpact(intel, { paths, symbols, maxDepth });
  const centrality = calculateGraphCentrality(intel);
  const coreSet = new Set(centrality.critical_core_files);

  const directSeeds = transitive.seeds;
  const directCoreHit = directSeeds.filter(p => coreSet.has(p));
  const transitiveCoreHit = transitive.transitive_dependents.filter(d => coreSet.has(d.path)).map(d => d.path);

  const totalAffected = transitive.total_impacted_files + directSeeds.length;
  let riskLevel = 'LOW';
  if (directCoreHit.length > 0 || totalAffected > 15) {
    riskLevel = 'CRITICAL';
  } else if (transitiveCoreHit.length > 0 || totalAffected > 8) {
    riskLevel = 'HIGH';
  } else if (totalAffected > 3) {
    riskLevel = 'MEDIUM';
  }

  return withCapability(intel, {
    query: 'getBlastRadiusAnalysis',
    seeds: directSeeds,
    risk_level: riskLevel,
    total_affected_count: totalAffected,
    direct_core_hits: directCoreHit,
    transitive_core_hits: transitiveCoreHit,
    transitive_dependents_count: transitive.total_impacted_files,
    direct_dependents: transitive.direct_dependents,
    transitive_dependents: transitive.transitive_dependents
  });
}
