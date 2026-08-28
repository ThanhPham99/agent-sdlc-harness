// Canonical traceability graph and graph-driven invalidation.
//
// The graph exists so two questions have deterministic answers:
//
//   Coverage: is every applicable acceptance criterion implemented, verified,
//   and backed by evidence — with a real edge, not a claim?
//
//   Invalidation: when a requirement, design decision or interface changes,
//   exactly which downstream artifacts stop being trustworthy? A docs wording
//   change must not invalidate implementation; a public interface change must
//   invalidate consumers and compatibility tests even when the code compiles.
import fs from 'node:fs';
import path from 'node:path';
import {now,readJson,sha256,writeJson} from './util.mjs';
import {stateDir,listTasks,loadTaskGraph,artifactsForRun,artifactBindings} from './store.mjs';

const arr=x=>Array.isArray(x)?x:[];

export const NODE_KINDS=['REQUIREMENT','ACCEPTANCE_CRITERION','DESIGN_DECISION','TASK','SYMBOL','INTERFACE','DATA_ENTITY','TEST','EVIDENCE','REVIEW_FINDING','BUILD','RELEASE','DEPLOYMENT','OBSERVATION','DOCUMENTATION'];
export const EDGE_KINDS=['decomposes_to','addressed_by','implemented_by','changes','affects','verified_by','produces','reviewed_by','supports','contains','deploys','validates','documents'];

export const nodeId=(kind,key)=>`${kind}:${key}`;
const graphPath=(projectRoot,runId)=>path.join(stateDir(projectRoot),'traceability',`${runId}.json`);

export function loadTraceabilityGraph(projectRoot,runId){
  const p=graphPath(projectRoot,runId);
  return fs.existsSync(p)?readJson(p):null;
}
export function saveTraceabilityGraph(projectRoot,graph){
  graph.updated_at=now();
  writeJson(graphPath(projectRoot,graph.run_id),graph);
  return graph;
}

function emptyGraph(runId,revision){
  return {schema:'agent-sdlc/traceability-graph/v1',run_id:runId,revision:revision??null,
    nodes:[],edges:[],created_at:now(),updated_at:now()};
}

/**
 * Build the graph from durable state: the task graph, the task records and the
 * recorded artifacts. Nothing is inferred from prose.
 */
export function buildTraceabilityGraph(projectRoot,runId,{run=null,revision=null,designDecisions=[],documentation=[],release=null}={}){
  const taskGraph=loadTaskGraph(projectRoot,runId);
  const tasks=listTasks(projectRoot,runId);
  // By binding, not by the metadata's first owner: an artifact two runs
  // stored identical bytes for belongs to both of them.
  const artifacts=artifactsForRun(projectRoot,runId);
  const g=emptyGraph(runId,revision??taskGraph?.source_revision??null);
  const nodeIndex=new Map();

  const addNode=(kind,key,extra={})=>{
    const id=nodeId(kind,key);
    if(nodeIndex.has(id))return id;
    const node={id,kind,label:extra.label??String(key),status:extra.status??null,ref:extra.ref??null,
      sha256:extra.sha256??null,revision:extra.revision??null,valid:extra.valid!==false,invalidated_by:extra.invalidated_by??null};
    nodeIndex.set(id,node);g.nodes.push(node);
    return id;
  };
  const addEdge=(from,to,kind)=>{
    if(!EDGE_KINDS.includes(kind))throw new Error(`unknown traceability edge kind ${kind}`);
    if(!g.edges.some(e=>e.from===from&&e.to===to&&e.kind===kind))g.edges.push({from,to,kind});
  };

  // Requirements decompose to acceptance criteria; the run objective is the root.
  const objective=run?.objective??null;
  const reqId=addNode('REQUIREMENT',runId,{label:objective||runId});
  for(const ac of arr(taskGraph?.requirements))addEdge(reqId,addNode('ACCEPTANCE_CRITERION',ac),'decomposes_to');

  // Design decisions address acceptance criteria and are implemented by tasks.
  const declaredDesign=new Set([...arr(taskGraph?.design_decisions),...designDecisions.map(d=>d?.decision_id||d)].filter(Boolean));
  for(const d of declaredDesign){
    const detail=designDecisions.find(x=>x?.decision_id===d);
    const dId=addNode('DESIGN_DECISION',d,{status:detail?.approval?.status??null,label:detail?.objective??d});
    for(const ac of arr(detail?.requirements))addEdge(addNode('ACCEPTANCE_CRITERION',ac),dId,'addressed_by');
  }

  const artifactByKindTask=(kind,taskId)=>artifacts.filter(a=>a.kind===kind&&String(a.filename||'').startsWith(taskId));

  for(const task of tasks){
    const tId=addNode('TASK',task.task_id,{status:task.status,label:task.title,revision:task.base_revision??null,sha256:task.diff_hash??null});
    for(const ac of arr(task.acceptance_criteria))addEdge(addNode('ACCEPTANCE_CRITERION',ac),tId,'implemented_by');
    for(const d of arr(task.design_decisions))addEdge(addNode('DESIGN_DECISION',d),tId,'implemented_by');
    for(const sym of arr(task.scope?.symbols))addEdge(tId,addNode('SYMBOL',sym),'changes');
    for(const p of arr(task.scope?.write))addEdge(tId,addNode('SYMBOL',p,{label:p}),'changes');
    for(const iface of arr(task.scope?.interfaces))addEdge(tId,addNode('INTERFACE',iface),'affects');
    for(const test of arr(task.verification?.targeted_tests)){
      const testId=addNode('TEST',test);
      addEdge(tId,testId,'verified_by');
      for(const ev of arr(task.evidence_refs)){
        const evId=addNode('EVIDENCE',ev,{ref:ev});
        addEdge(testId,evId,'produces');
        addEdge(evId,tId,'supports');
      }
    }
    for(const ev of arr(task.evidence_refs)){
      const evId=addNode('EVIDENCE',ev,{ref:ev});
      addEdge(evId,tId,'supports');
    }
    for(const rev of arr(task.review_refs))addEdge(tId,addNode('REVIEW_FINDING',rev,{ref:rev}),'reviewed_by');
    if(task.risk?.destructive_data_change||task.category==='migration'){
      for(const p of arr(task.scope?.write))addEdge(tId,addNode('DATA_ENTITY',path.posix.basename(String(p))),'affects');
    }
    for(const a of artifactByKindTask('task-verification',task.task_id)){
      const evId=addNode('EVIDENCE',a.artifact_id,{ref:a.artifact_id,sha256:a.sha256,revision:artifactBindings(a).find(b=>b.run_id===runId)?.source_revision??a.source_revision});
      addEdge(evId,tId,'supports');
    }
  }

  if(release){
    const buildId=addNode('BUILD',release.build_id||`${runId}-build`,{sha256:release.build_sha256??null,revision:release.revision??null});
    for(const task of tasks)addEdge(buildId,nodeId('TASK',task.task_id),'contains');
    const relId=addNode('RELEASE',release.release_id||`${runId}-release`,{revision:release.revision??null});
    addEdge(relId,buildId,'contains');
    if(release.deployment_id){
      const depId=addNode('DEPLOYMENT',release.deployment_id);
      addEdge(depId,relId,'deploys');
      if(release.observation_id)addEdge(addNode('OBSERVATION',release.observation_id),depId,'validates');
    }
  }
  for(const doc of documentation){
    const dId=addNode('DOCUMENTATION',doc.path||doc,{ref:doc.path||doc});
    for(const target of arr(doc.documents))if(nodeIndex.has(target))addEdge(dId,target,'documents');
  }

  saveTraceabilityGraph(projectRoot,g);
  return g;
}

// --- consistency and coverage ----------------------------------------------

/** Dangling refs, unknown kinds and orphan nodes. Rejected, not tolerated. */
export function validateTraceabilityGraph(graph){
  const errors=[];const warnings=[];
  const ids=new Set(arr(graph?.nodes).map(n=>n.id));
  if(graph?.schema!=='agent-sdlc/traceability-graph/v1')errors.push({code:'SCHEMA_MISMATCH'});
  for(const n of arr(graph?.nodes)){
    if(!NODE_KINDS.includes(n.kind))errors.push({code:'UNKNOWN_NODE_KIND',id:n.id,kind:n.kind});
    if(!n.id.startsWith(`${n.kind}:`))errors.push({code:'NODE_ID_KIND_MISMATCH',id:n.id});
  }
  const seen=new Set();
  for(const n of arr(graph?.nodes)){
    if(seen.has(n.id))errors.push({code:'DUPLICATE_NODE',id:n.id});
    seen.add(n.id);
  }
  for(const e of arr(graph?.edges)){
    if(!EDGE_KINDS.includes(e.kind))errors.push({code:'UNKNOWN_EDGE_KIND',kind:e.kind});
    if(!ids.has(e.from))errors.push({code:'DANGLING_EDGE_FROM',edge:e});
    if(!ids.has(e.to))errors.push({code:'DANGLING_EDGE_TO',edge:e});
  }
  const connected=new Set(arr(graph?.edges).flatMap(e=>[e.from,e.to]));
  for(const n of arr(graph?.nodes))if(!connected.has(n.id))warnings.push({code:'ORPHAN_NODE',id:n.id});
  return {schema:'agent-sdlc/traceability-validation/v1',valid:errors.length===0,
    node_count:arr(graph?.nodes).length,edge_count:arr(graph?.edges).length,errors,warnings};
}

const outEdges=(graph,id,kind)=>arr(graph.edges).filter(e=>e.from===id&&(!kind||e.kind===kind));
const inEdges=(graph,id,kind)=>arr(graph.edges).filter(e=>e.to===id&&(!kind||e.kind===kind));
const nodeOf=(graph,id)=>arr(graph.nodes).find(n=>n.id===id)||null;

/**
 * Acceptance-criterion coverage through real edges. A claim of coverage with no
 * edge is exactly what this reports as uncovered.
 */
export function computeTraceCoverage(graph){
  const criteria=arr(graph.nodes).filter(n=>n.kind==='ACCEPTANCE_CRITERION');
  const rows=criteria.map(ac=>{
    const tasks=outEdges(graph,ac.id,'implemented_by').map(e=>e.to).filter(id=>id.startsWith('TASK:'));
    const tests=tasks.flatMap(t=>outEdges(graph,t,'verified_by').map(e=>e.to));
    const evidence=tasks.flatMap(t=>inEdges(graph,t,'supports').map(e=>e.from));
    const done=tasks.filter(t=>nodeOf(graph,t)?.status==='DONE');
    return {acceptance_criterion:ac.id.replace('ACCEPTANCE_CRITERION:',''),
      implemented_by:tasks,verified_by:[...new Set(tests)],evidence:[...new Set(evidence)],
      done_tasks:done.length,
      covered:tasks.length>0,verified:tests.length>0,evidenced:evidence.length>0};
  });
  const ratio=(n,d)=>d?Number((n/d).toFixed(4)):1;
  const interfaces=arr(graph.nodes).filter(n=>n.kind==='INTERFACE');
  const interfaceRows=interfaces.map(i=>{
    const tasks=inEdges(graph,i.id,'affects').map(e=>e.from);
    const tests=tasks.flatMap(t=>outEdges(graph,t,'verified_by').map(e=>e.to));
    return {interface:i.id.replace('INTERFACE:',''),affected_by:tasks,compatibility_tests:[...new Set(tests)],
      verified:tests.length>0};
  });
  return {
    schema:'agent-sdlc/trace-coverage/v1',
    criteria:rows,
    ac_coverage:ratio(rows.filter(r=>r.covered).length,rows.length),
    verification_coverage:ratio(rows.filter(r=>r.verified).length,rows.length),
    evidence_coverage:ratio(rows.filter(r=>r.evidenced).length,rows.length),
    uncovered:rows.filter(r=>!r.covered).map(r=>r.acceptance_criterion),
    unverified:rows.filter(r=>r.covered&&!r.verified).map(r=>r.acceptance_criterion),
    unevidenced:rows.filter(r=>r.covered&&!r.evidenced).map(r=>r.acceptance_criterion),
    interfaces:interfaceRows,
    interfaces_without_compatibility_verification:interfaceRows.filter(r=>!r.verified).map(r=>r.interface)
  };
}

// --- graph-driven invalidation ---------------------------------------------

export const DELTA_CLASSES=['WORDING_ONLY','BEHAVIOR_CHANGE','DESIGN_CHANGE','INTERFACE_CHANGE','DATA_CHANGE','DOCUMENTATION_ONLY','SCOPE_REMOVAL'];

/**
 * What a delta class propagates through. WORDING_ONLY and DOCUMENTATION_ONLY
 * deliberately propagate through nothing: a reworded requirement must not throw
 * away working implementation.
 */
// `edges` are followed from the changed node outwards. `reverse` names the edge
// kinds that must also be followed *inwards*, because the arrow points the
// other way: a consumer task points at the INTERFACE it affects, and evidence
// points at the TASK it supports.
const REVERSE_ALWAYS=['supports','produces'];
const PROPAGATION={
  WORDING_ONLY:{edges:[],reverse:[],kinds:[],note:'wording changes carry no downstream semantics'},
  DOCUMENTATION_ONLY:{edges:['documents'],reverse:[],kinds:['DOCUMENTATION'],note:'only the documentation nodes themselves'},
  BEHAVIOR_CHANGE:{edges:['addressed_by','implemented_by','verified_by','produces','reviewed_by','contains'],
    reverse:[],
    kinds:['DESIGN_DECISION','TASK','TEST','EVIDENCE','REVIEW_FINDING','BUILD','RELEASE','DEPLOYMENT']},
  DESIGN_CHANGE:{edges:['implemented_by','verified_by','produces','reviewed_by','contains'],
    reverse:[],
    kinds:['TASK','TEST','EVIDENCE','REVIEW_FINDING','BUILD','RELEASE','DEPLOYMENT']},
  INTERFACE_CHANGE:{edges:['affects','verified_by','produces','reviewed_by','contains'],
    reverse:['affects'],
    kinds:['TASK','TEST','EVIDENCE','REVIEW_FINDING','BUILD','RELEASE','DEPLOYMENT','INTERFACE'],
    note:'consumers and compatibility tests are invalidated even when the code still compiles'},
  DATA_CHANGE:{edges:['affects','verified_by','produces','reviewed_by','contains'],
    reverse:['affects'],
    kinds:['TASK','TEST','EVIDENCE','REVIEW_FINDING','BUILD','RELEASE','DEPLOYMENT','DATA_ENTITY']},
  SCOPE_REMOVAL:{edges:['implemented_by','verified_by','produces','reviewed_by'],
    reverse:[],
    kinds:['TASK','TEST','EVIDENCE','REVIEW_FINDING']}
};

const EARLIEST_GATE={
  BEHAVIOR_CHANGE:'REQUIREMENTS',DESIGN_CHANGE:'DESIGN',INTERFACE_CHANGE:'DESIGN',
  DATA_CHANGE:'DESIGN',SCOPE_REMOVAL:'PLAN',WORDING_ONLY:null,DOCUMENTATION_ONLY:'CLOSE'
};

/**
 * Downstream closure of one changed node under a delta class, with the graph
 * path that justified each inclusion. Unrelated nodes are untouched by
 * construction: only declared edge kinds are traversed.
 */
export function computeInvalidationClosure(graph,changedNodeId,deltaClass,{maxDepth=8}={}){
  if(!DELTA_CLASSES.includes(deltaClass))throw new Error(`unknown delta class ${deltaClass}`);
  const rule=PROPAGATION[deltaClass];
  const start=nodeOf(graph,changedNodeId);
  const affected=new Map();
  const reverseKinds=new Set([...REVERSE_ALWAYS,...(rule.reverse||[])]);
  if(start&&rule.edges.length){
    let frontier=[{id:changedNodeId,path:[changedNodeId]}];
    for(let depth=1;depth<=maxDepth&&frontier.length;depth++){
      const next=[];
      for(const cur of frontier){
        for(const e of arr(graph.edges)){
          const forward=e.from===cur.id&&rule.edges.includes(e.kind);
          const backward=e.to===cur.id&&reverseKinds.has(e.kind);
          if(!forward&&!backward)continue;
          const nextId=forward?e.to:e.from;
          if(nextId===changedNodeId||affected.has(nextId))continue;
          const node=nodeOf(graph,nextId);
          if(!node||!rule.kinds.includes(node.kind))continue;
          affected.set(nextId,{id:nextId,kind:node.kind,status:node.status??null,depth,
            path:[...cur.path,`${e.kind}->`,nextId]});
          next.push({id:nextId,path:[...cur.path,`${e.kind}->`,nextId]});
        }
      }
      frontier=next;
    }
  }
  const rows=[...affected.values()].sort((a,b)=>a.depth-b.depth||a.id.localeCompare(b.id));
  const preserved=arr(graph.nodes).filter(n=>n.id!==changedNodeId&&!affected.has(n.id))
    .map(n=>({id:n.id,kind:n.kind,status:n.status??null}));
  return {
    schema:'agent-sdlc/invalidation-closure/v1',
    changed:changedNodeId,
    changed_exists:!!start,
    delta_class:deltaClass,
    rule_note:rule.note??null,
    propagates_through:rule.edges,
    propagates_backwards_through:[...reverseKinds].filter(k=>rule.edges.includes(k)||(rule.reverse||[]).includes(k)),
    affected:rows,
    affected_count:rows.length,
    preserved,
    preserved_count:preserved.length,
    affected_tasks:rows.filter(r=>r.kind==='TASK').map(r=>r.id.replace('TASK:','')),
    affected_tests:rows.filter(r=>r.kind==='TEST').map(r=>r.id.replace('TEST:','')),
    invalidated_evidence:rows.filter(r=>r.kind==='EVIDENCE').map(r=>r.id.replace('EVIDENCE:','')),
    earliest_outer_gate:EARLIEST_GATE[deltaClass],
    replayable:true
  };
}

/**
 * Apply a closure: mark affected nodes invalid with the reason and the graph
 * path that justified it. Preserved nodes keep their validity untouched.
 */
export function applyInvalidation(projectRoot,graph,closure,{reason='upstream change'}={}){
  const affected=new Set(closure.affected.map(a=>a.id));
  for(const n of graph.nodes){
    if(affected.has(n.id)){
      n.valid=false;
      n.invalidated_by=`${closure.changed}:${closure.delta_class}:${reason}`;
    }
  }
  const record={
    schema:'agent-sdlc/invalidation-record/v1',
    run_id:graph.run_id,
    changed:closure.changed,
    delta_class:closure.delta_class,
    reason,
    affected:closure.affected.map(a=>({id:a.id,kind:a.kind,depth:a.depth,path:a.path})),
    preserved_count:closure.preserved_count,
    earliest_outer_gate:closure.earliest_outer_gate,
    // Sorted by id: the anchor identifies the graph's state, not the order the
    // walk happened to discover it in. Part of that order comes from
    // listArtifacts() -> fs.readdirSync(), which Node does not promise to sort
    // -- NTFS returns names in B-tree order, ext4 with dir_index returns hash
    // order -- so an unsorted anchor is a different number on the Linux runner
    // than on a Windows workstation for the very same state.
    graph_sha256:sha256(JSON.stringify(graph.nodes.map(n=>[n.id,n.valid]).sort((a,b)=>a[0].localeCompare(b[0])))),
    time:now()
  };
  saveTraceabilityGraph(projectRoot,graph);
  const p=path.join(stateDir(projectRoot),'traceability',`${graph.run_id}-invalidations.jsonl`);
  fs.mkdirSync(path.dirname(p),{recursive:true});
  fs.appendFileSync(p,JSON.stringify(record)+'\n');
  return record;
}

/** Replay the recorded invalidation decisions for a run. */
export function invalidationHistory(projectRoot,runId){
  const p=path.join(stateDir(projectRoot),'traceability',`${runId}-invalidations.jsonl`);
  if(!fs.existsSync(p))return [];
  return fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
}
