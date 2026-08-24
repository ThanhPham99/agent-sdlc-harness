#!/usr/bin/env node
// Release evidence for the alpha6 subsystems. Runs the same suite `npm test`
// asserts on, then writes one evidence file per subsystem. Offline: no host
// CLI, no network, no model.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runAlpha6Suite} from '../evals/alpha6-runtime.mjs';
import {CAPABILITY_TIERS,IMPLEMENTED_TIER} from '../runtime/repo-index.mjs';
import {NODE_KINDS,EDGE_KINDS,DELTA_CLASSES} from '../runtime/traceability.mjs';
import {DELIVERY_TARGETS} from '../runtime/git-delivery.mjs';
import {CI_STATUSES} from '../runtime/ci-evidence.mjs';
import {LEARNING_SOURCES} from '../runtime/learning.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rj=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const VERSION=rj('agent-sdlc.manifest.json').version;
const out=(file,obj)=>fs.writeFileSync(path.join(ROOT,'evals',file),JSON.stringify(obj,null,2)+'\n');

const suite=runAlpha6Suite(ROOT);
const byGroup=Object.fromEntries(suite.groups.map(g=>[g.group,g]));
const block=g=>{
  const x=byGroup[g]||{checks:0,passes:0,failures:0,results:[]};
  return {checks:x.checks,passes:x.passes,failures:x.failures,results:x.results,status:x.failures?'FAIL':'PASS'};
};
const governance=rj('policies/cost-context-governance.json');

out('REPO-INTELLIGENCE-VALIDATION.json',{
  schema:'agent-sdlc/repo-intelligence-validation/v1',
  version:VERSION,
  capability:{
    tiers:CAPABILITY_TIERS,
    implemented:IMPLEMENTED_TIER,
    claim:'deterministic syntax extraction only; a higher tier requires an external index this harness does not bundle',
    llm_inference_used:false,
    every_query_reports_its_tier:true
  },
  index:{
    location:'.agent-sdlc/index/repo-index.json',
    incremental:'content-hash cache; a clean tree re-parses nothing',
    revision_bound:true,
    scope:'git-tracked files, honouring .gitignore'
  },
  query_api:['findSymbol','findReferences','findTestsForSymbol','findTestsForFiles','findModuleBoundary',
    'findDependents','findPublicInterfaces','findDataEntities','findEventContracts','findRecentChanges','getMinimalChangeSurface'],
  context_integration:{
    module:'runtime/task-context.mjs scopeIntelligence()',
    rule:'anchored to the task declared scope, consulted before any broad repo.search, never mined from free text',
    no_match_behaviour:'reports NO_DETERMINISTIC_MATCH_BROADER_SEARCH_REQUIRED instead of returning the repository'
  },
  ...block('repo_intelligence'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('TRACEABILITY-VALIDATION.json',{
  schema:'agent-sdlc/traceability-validation/v1',
  version:VERSION,
  graph_schema:'agent-sdlc/traceability-graph/v1',
  node_kinds:NODE_KINDS,
  edge_kinds:EDGE_KINDS,
  storage:'IDs, refs and hashes only; never duplicated content',
  coverage:{
    derived_from:'graph edges, never from a claim',
    reports:['ac_coverage','verification_coverage','evidence_coverage','interfaces_without_compatibility_verification']
  },
  consistency:'dangling edges, unknown kinds, duplicate nodes and id/kind mismatches are rejected; orphans are warned',
  ...block('traceability'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('INVALIDATION-VALIDATION.json',{
  schema:'agent-sdlc/invalidation-validation/v1',
  version:VERSION,
  delta_classes:DELTA_CLASSES,
  principles:[
    'WORDING_ONLY and DOCUMENTATION_ONLY propagate through nothing that touches implementation',
    'a public interface change invalidates consumers and compatibility tests even when the code still compiles',
    'only declared edge kinds are traversed, so unrelated work is preserved by construction',
    'every affected node carries the graph path that justified including it',
    'each decision is appended to a replayable invalidation log with the earliest outer gate'
  ],
  ...block('invalidation'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('DELIVERY-VALIDATION.json',{
  schema:'agent-sdlc/delivery-validation/v1',
  version:VERSION,
  targets:DELIVERY_TARGETS,
  ci_statuses:CI_STATUSES,
  rules:[
    'CI evidence is bound to an exact revision; a revision change invalidates it',
    'a failing required check fails the record; an optional failure does not',
    'MERGED requires an observed merge commit — a prepared PR is only PR_READY',
    'target-base drift blocks delivery and requests re-impact and re-verification',
    'protected-branch push is denied by default and needs a recorded operator approval',
    'stacked dependency order must be explicit',
    'interface-changing and migration work each get their own bounded branch'
  ],
  ...block('delivery'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('FALLBACK-VALIDATION.json',{
  schema:'agent-sdlc/fallback-validation/v1',
  version:VERSION,
  checkpoint_schema:'agent-sdlc/task-checkpoint/v1',
  transfers:['context manifest hash','base revision','diff hash','artifact refs','evidence refs','review refs','failure class'],
  never_transfers:['provider_conversation_history','hidden_chain_of_thought','worker_scratch_reasoning'],
  risk:'risk profile, security/data risk and the independent-review requirement are properties of the task and survive a provider change',
  no_fallback_provider:'reported as NO_FALLBACK_PROVIDER rather than a silent no-op',
  ...block('fallback'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('GOVERNOR-VALIDATION.json',{
  schema:'agent-sdlc/governor-validation/v1',
  version:VERSION,
  objective:governance.objective,
  hard_rule:governance.hard_rule,
  inputs:governance.inputs,
  decisions:governance.decisions,
  explainability:'every decision records the inputs, the model floor and a reason per decision',
  ...block('governor'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

out('LEARNING-VALIDATION.json',{
  schema:'agent-sdlc/learning-validation/v1',
  version:VERSION,
  sources:LEARNING_SOURCES,
  sanitization:['AWS key ids','private keys','provider tokens','JWTs','key/value secrets','emails','IP addresses','absolute and home paths','URLs'],
  guarantees:[
    'a candidate is deterministic: the same failure yields the same candidate id',
    'validation re-scans the serialized candidate and rejects any surviving secret or absolute path',
    'no policy is mutated: a policy hypothesis is PROPOSED_NOT_APPLIED and adoption requires eval pass plus human review',
    'each source routes to a runnable eval suite'
  ],
  candidate_output:'evals/regressions/candidates/ (written only by scripts/promote-regression-case.mjs)',
  ...block('learning'),
  live_qualification:'PENDING_LIVE_QUALIFICATION'
});

const summary={
  schema:'agent-sdlc/alpha6-validation-summary/v1',
  version:VERSION,
  groups:suite.groups.map(g=>({group:g.group,checks:g.checks,passes:g.passes,failures:g.failures})),
  checks:suite.checks,passes:suite.passes,failures:suite.failures,
  evidence:[
    'evals/REPO-INTELLIGENCE-VALIDATION.json',
    'evals/TRACEABILITY-VALIDATION.json',
    'evals/INVALIDATION-VALIDATION.json',
    'evals/DELIVERY-VALIDATION.json',
    'evals/FALLBACK-VALIDATION.json',
    'evals/GOVERNOR-VALIDATION.json',
    'evals/LEARNING-VALIDATION.json'
  ],
  status:suite.failures?'FAIL':'PASS'
};
console.log(JSON.stringify(summary,null,2));
process.exit(suite.failures?1:0);
