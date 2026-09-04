// Deterministic implementation-plan quality gate.
//
// A plan is only useful if it is executable. This module answers structural
// questions with code, never with model prose:
//   - is the dependency graph a DAG with resolvable references?
//   - is every acceptance criterion implemented and verified by some task?
//   - can the declared parallel candidates actually run at the same time?
//   - do risky tasks carry compatibility / rollback / verification obligations?
//
// No repository reads, no network, no model inference. Same input -> same output.

export const PLAN_SCHEMA='agent-sdlc/task-plan/v1';
export const TASK_CATEGORIES=['implementation','migration','verification','security','integration','documentation','release','operability'];

// Thresholds live here rather than in a separate policy file so the gate cannot
// drift from the validator that enforces it. Override per call via `context`.
export const PLAN_QUALITY_DEFAULTS={
  giant_task_module_threshold:3,
  giant_task_write_scope_threshold:12,
  micro_plan_profiles:['FAST'],
  required_task_fields:['goal','scope','done_condition','verification']
};

const arr=(x)=>Array.isArray(x)?x:[];

// Scope entries are path prefixes or globs. The overlap predicate is shared
// with the scheduler that has to honour this gate's verdict at dispatch time --
// see runtime/scope.mjs for why it is not defined twice.
import {scopeOverlap} from './scope.mjs';

function overlappingPairs(listA,listB){
  const out=[];
  for(const a of listA)for(const b of listB)if(scopeOverlap(a,b))out.push([a,b]);
  return out;
}

/** Derive the canonical task graph. Edges always come from depends_on. */
export function computeTaskGraph(plan){
  const tasks=arr(plan?.tasks);
  const ids=tasks.map(t=>t?.task_id).filter(Boolean);
  const known=new Set(ids);
  const nodes=tasks.map(t=>({
    task_id:t?.task_id??null,
    category:t?.category||'implementation',
    depends_on:arr(t?.depends_on),
    parallel_candidate:t?.parallel_candidate===true
  }));
  const edges=[];const unknown_dependencies=[];
  for(const n of nodes){
    for(const dep of n.depends_on){
      if(!known.has(dep))unknown_dependencies.push({task_id:n.task_id,depends_on:dep});
      else edges.push({from:dep,to:n.task_id,kind:'depends_on'});
    }
  }
  return {
    schema:'agent-sdlc/task-graph-view/v1',
    plan_id:plan?.plan_id??null,
    run_id:plan?.run_id??null,
    node_count:nodes.length,
    edge_count:edges.length,
    nodes,
    edges,
    unknown_dependencies
  };
}

/** All simple dependency cycles, reported as canonical rotated id lists. */
export function findCycles(plan){
  const tasks=arr(plan?.tasks);
  const known=new Set(tasks.map(t=>t?.task_id).filter(Boolean));
  const deps=new Map(tasks.map(t=>[t?.task_id,arr(t?.depends_on).filter(d=>known.has(d))]));
  const cycles=[];const seen=new Set();
  const state=new Map(); // 0 unvisited, 1 on stack, 2 done
  const stack=[];
  const canonical=(cycle)=>{
    const i=cycle.indexOf([...cycle].sort()[0]);
    const rotated=[...cycle.slice(i),...cycle.slice(0,i)];
    return rotated.join('->');
  };
  const visit=(id)=>{
    state.set(id,1);stack.push(id);
    for(const dep of deps.get(id)||[]){
      if(state.get(dep)===1){
        const cycle=stack.slice(stack.indexOf(dep));
        const key=canonical(cycle);
        if(!seen.has(key)){seen.add(key);cycles.push(cycle);}
      }else if((state.get(dep)||0)===0)visit(dep);
    }
    stack.pop();state.set(id,2);
  };
  for(const id of known)if(!state.get(id))visit(id);
  return cycles;
}

/** Topological wave decomposition: ready set per round, ignoring conflicts. */
export function computeReadySets(plan){
  const tasks=arr(plan?.tasks);
  const known=new Set(tasks.map(t=>t?.task_id).filter(Boolean));
  const pending=new Map(tasks.map(t=>[t?.task_id,new Set(arr(t?.depends_on).filter(d=>known.has(d)))]));
  const done=new Set();const waves=[];
  while(pending.size){
    const ready=[...pending.entries()].filter(([,d])=>[...d].every(x=>done.has(x))).map(([id])=>id).sort();
    if(!ready.length)break; // remaining nodes are inside a cycle
    waves.push(ready);
    for(const id of ready){done.add(id);pending.delete(id);}
  }
  return {waves,unreachable:[...pending.keys()].sort()};
}

/** Acceptance-criterion implementation and verification coverage. */
export function computeCoverage(plan){
  const tasks=arr(plan?.tasks);
  const required=[...new Set(arr(plan?.requirements))];
  const implementing=new Map();const verifying=new Map();
  for(const ac of required){implementing.set(ac,[]);verifying.set(ac,[]);}
  for(const t of tasks){
    for(const ac of arr(t?.acceptance_criteria)){
      if(!implementing.has(ac)){implementing.set(ac,[]);verifying.set(ac,[]);}
      implementing.get(ac).push(t?.task_id);
      const v=t?.verification||{};
      if(arr(v.targeted_tests).length||arr(v.expected_behavior).length)verifying.get(ac).push(t?.task_id);
    }
  }
  const uncovered=required.filter(ac=>!(implementing.get(ac)||[]).length);
  const unverified=required.filter(ac=>(implementing.get(ac)||[]).length&&!(verifying.get(ac)||[]).length);
  const unknown_criteria=[...implementing.keys()].filter(ac=>required.length&&!required.includes(ac));
  const ratio=(n)=>required.length?Number(((required.length-n)/required.length).toFixed(4)):1;
  return {
    required_criteria:required,
    ac_coverage:ratio(uncovered.length),
    verification_coverage:ratio(uncovered.length+unverified.length),
    uncovered,
    unverified,
    unknown_criteria,
    by_criterion:Object.fromEntries(required.map(ac=>[ac,{implemented_by:implementing.get(ac)||[],verified_by:verifying.get(ac)||[]}]))
  };
}

/** Write / interface conflicts between tasks declared as parallel candidates. */
export function computeScopeConflicts(plan){
  const tasks=arr(plan?.tasks);
  const candidates=tasks.filter(t=>t?.parallel_candidate===true);
  const graph=computeTaskGraph(plan);
  const related=new Set(graph.edges.map(e=>`${e.from}|${e.to}`));
  const conflicts=[];
  for(let i=0;i<candidates.length;i++){
    for(let j=i+1;j<candidates.length;j++){
      const a=candidates[i],b=candidates[j];
      // A declared dependency already serializes the pair; that is not a conflict.
      if(related.has(`${a.task_id}|${b.task_id}`)||related.has(`${b.task_id}|${a.task_id}`))continue;
      const w=overlappingPairs(arr(a.write_scope),arr(b.write_scope));
      if(w.length)conflicts.push({kind:'WRITE_SCOPE',tasks:[a.task_id,b.task_id],overlaps:w});
      const s=overlappingPairs(arr(a.interface_scope),arr(b.interface_scope));
      if(s.length)conflicts.push({kind:'INTERFACE_SCOPE',tasks:[a.task_id,b.task_id],overlaps:s});
    }
  }
  return conflicts;
}

/**
 * Full deterministic validation. Returns {valid, errors, warnings, metrics}.
 * FAST plans are validated as micro-plans: the graph invariants still apply,
 * but plan-wide coverage obligations are relaxed to warnings.
 */
export function validateTaskPlan(plan,context={}){
  const cfg={...PLAN_QUALITY_DEFAULTS,...(context.thresholds||{})};
  const errors=[];const warnings=[];
  const p=plan||{};
  const profile=p.profile||context.profile||'STANDARD';
  const micro=cfg.micro_plan_profiles.includes(profile);
  const push=(code,detail)=>errors.push(detail===undefined?{code}:{code,...detail});
  const warn=(code,detail)=>warnings.push(detail===undefined?{code}:{code,...detail});
  const soft=micro?warn:push;

  if(p.schema!==PLAN_SCHEMA)push('PLAN_SCHEMA_MISMATCH',{found:p.schema??null});
  if(!p.plan_id)push('MISSING_PLAN_ID');
  if(!p.objective)push('MISSING_OBJECTIVE');
  const tasks=arr(p.tasks);
  if(!tasks.length)push('EMPTY_PLAN');

  // ---- per-task structure ------------------------------------------------
  const seen=new Set();
  for(const t of tasks){
    const id=t?.task_id||'?';
    if(!t?.task_id)push('TASK_MISSING_ID');
    else if(seen.has(t.task_id))push('DUPLICATE_TASK_ID',{task_id:t.task_id});
    else seen.add(t.task_id);
    if(!t?.title)warn('TASK_MISSING_TITLE',{task_id:id});
    if(!t?.goal)push('TASK_MISSING_GOAL',{task_id:id});
    if(!arr(t?.done_conditions).length)push('TASK_MISSING_DONE_CONDITION',{task_id:id});
    if(t?.category&&!TASK_CATEGORIES.includes(t.category))push('TASK_UNKNOWN_CATEGORY',{task_id:id,category:t.category});

    const v=t?.verification||{};
    const hasVerification=arr(v.targeted_tests).length>0||arr(v.expected_behavior).length>0;
    const changesBehavior=t?.changes_behavior!==false;
    if(changesBehavior&&!hasVerification)push('BEHAVIOR_TASK_WITHOUT_VERIFICATION',{task_id:id});

    const writeScope=arr(t?.write_scope);
    if(!writeScope.length&&changesBehavior)soft('TASK_MISSING_WRITE_SCOPE',{task_id:id});

    if(arr(t?.interface_scope).length&&!arr(t?.compatibility_obligations).length){
      push('INTERFACE_TASK_WITHOUT_COMPATIBILITY_OBLIGATION',{task_id:id});
    }
    if((t?.risk?.destructive_data_change===true||t?.category==='migration'&&t?.risk?.data==='HIGH')
       &&!arr(t?.rollback_obligations).length){
      push('DESTRUCTIVE_TASK_WITHOUT_ROLLBACK',{task_id:id});
    }

    // Forbidden boundaries: plan-wide plus task-local.
    const forbidden=[...arr(p.forbidden_scope),...arr(t?.forbidden_scope)];
    const violations=overlappingPairs(writeScope,forbidden);
    if(violations.length)push('FORBIDDEN_SCOPE_VIOLATION',{task_id:id,overlaps:violations});

    // Giant-task detection: unrelated modules or an unbounded write surface.
    const modules=[...new Set(arr(t?.modules))];
    const tooManyModules=modules.length>=cfg.giant_task_module_threshold;
    const tooWide=writeScope.length>=cfg.giant_task_write_scope_threshold;
    if((tooManyModules||tooWide)&&!t?.scope_justification){
      push('GIANT_TASK_WITHOUT_JUSTIFICATION',{task_id:id,modules:modules.length,write_scope:writeScope.length});
    }
  }

  // ---- graph -------------------------------------------------------------
  const graph=computeTaskGraph(p);
  for(const u of graph.unknown_dependencies)push('UNKNOWN_DEPENDENCY',u);
  const cycles=findCycles(p);
  for(const c of cycles)push('CYCLE_DETECTED',{cycle:c});

  // Explicit edges, when supplied, must agree with depends_on.
  if(Array.isArray(p.edges)){
    const derived=new Set(graph.edges.map(e=>`${e.from}|${e.to}`));
    const declared=new Set(p.edges.map(e=>`${e.from}|${e.to}`));
    for(const e of declared)if(!derived.has(e))push('EDGE_NOT_IN_DEPENDS_ON',{edge:e});
    for(const e of derived)if(!declared.has(e))warn('DEPENDS_ON_NOT_IN_EDGES',{edge:e});
  }

  // ---- coverage ----------------------------------------------------------
  const coverage=computeCoverage(p);
  for(const ac of coverage.uncovered)soft('UNCOVERED_ACCEPTANCE_CRITERION',{acceptance_criterion:ac});
  for(const ac of coverage.unverified)soft('UNVERIFIED_ACCEPTANCE_CRITERION',{acceptance_criterion:ac});
  for(const ac of coverage.unknown_criteria)warn('TASK_REFERENCES_UNDECLARED_CRITERION',{acceptance_criterion:ac});

  // ---- upstream blockers -------------------------------------------------
  for(const d of arr(p.unresolved_design_decisions))push('UNRESOLVED_DESIGN_DECISION',{design_decision:d});
  for(const r of arr(p.unresolved_requirements))push('UNRESOLVED_REQUIREMENT',{requirement:r});
  const declaredDesign=new Set(arr(p.design_decisions));
  if(declaredDesign.size){
    for(const t of tasks){
      for(const d of arr(t?.design_decisions)){
        if(!declaredDesign.has(d))warn('TASK_REFERENCES_UNDECLARED_DESIGN_DECISION',{task_id:t?.task_id,design_decision:d});
      }
    }
  }

  // ---- parallelism -------------------------------------------------------
  const conflicts=computeScopeConflicts(p);
  for(const c of conflicts){
    push(c.kind==='WRITE_SCOPE'?'PARALLEL_WRITE_SCOPE_CONFLICT':'PARALLEL_INTERFACE_SCOPE_CONFLICT',
      {tasks:c.tasks,overlaps:c.overlaps});
  }

  // ---- required categories from workflow / risk overlays -----------------
  const present=new Set(tasks.map(t=>t?.category||'implementation'));
  for(const cat of arr(p.required_categories)){
    if(!present.has(cat))push('MISSING_REQUIRED_TASK_CATEGORY',{category:cat});
  }

  const ready=computeReadySets(p);
  const metrics={
    task_count:tasks.length,
    edge_count:graph.edge_count,
    ac_coverage:coverage.ac_coverage,
    verification_coverage:coverage.verification_coverage,
    cycle_count:cycles.length,
    parallel_candidate_count:tasks.filter(t=>t?.parallel_candidate===true).length,
    conflict_count:conflicts.length,
    wave_count:ready.waves.length,
    critical_path_length:ready.waves.length,
    unreachable_task_count:ready.unreachable.length
  };

  return {
    schema:'agent-sdlc/plan-validation/v1',
    valid:errors.length===0,
    plan_id:p.plan_id??null,
    run_id:p.run_id??null,
    profile,
    micro_plan:micro,
    ...metrics,
    errors,
    warnings,
    coverage,
    conflicts,
    waves:ready.waves,
    gate_evidence:errors.length===0?planGateEvidence():[]
  };
}

/** Evidence tokens a valid plan is allowed to claim at the PLAN gate. */
export function planGateEvidence(){
  return [
    'plan_artifact_created',
    'plan_schema_valid',
    'plan_graph_valid',
    'plan_acceptance_coverage_valid',
    'plan_scope_conflicts_resolved',
    'plan_ready'
  ];
}
