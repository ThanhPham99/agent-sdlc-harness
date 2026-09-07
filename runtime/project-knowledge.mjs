// Project knowledge readiness (G0). Knowledge itself is authored by the model
// through the project-bootstrap skill and stored as ordinary content-addressed
// artifacts (kind: system-context / architecture / standards / feature-index);
// this module only answers the deterministic question of whether that
// knowledge exists yet, so the orchestrator can decide whether to load the
// bootstrap skill before a new feature starts, without guessing at
// architecture it was never shown.
import {listArtifacts,artifactBindings} from './store.mjs';

export const KNOWLEDGE_KINDS=['system-context','architecture','standards','feature-index'];

// The metadata scan belongs to the store, not here: this module used to read
// the meta directory itself, which is why sharding it broke knowledge
// detection. `listArtifacts` is the one reader of that tree.
//
// A kind is matched across every binding, not just the top-level field. The
// top-level `kind` is the FIRST binding's, so knowledge content that another
// run had already stored byte-identically under a different kind would
// otherwise be invisible -- and normalized authored documents are exactly the
// content that collides.
function artifactsByKind(projectRoot,kind){
  return listArtifacts(projectRoot)
    .filter(meta=>artifactBindings(meta).some(b=>b.kind===kind))
    .sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
}

export function getProjectKnowledgeStatus(projectRoot){
  const present={};
  for(const kind of KNOWLEDGE_KINDS){
    const rows=artifactsByKind(projectRoot,kind);
    present[kind]=rows.length?rows.at(-1).artifact_id:null;
  }
  const have=KNOWLEDGE_KINDS.filter(k=>present[k]);
  const missing=KNOWLEDGE_KINDS.filter(k=>!present[k]);
  const status=have.length===0?'MISSING':missing.length===0?'READY':'PARTIAL';
  return {schema:'agent-sdlc/project-knowledge-status/v1',status,present,missing};
}
