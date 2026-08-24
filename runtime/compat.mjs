import fs from 'node:fs';
import path from 'node:path';
import {readJson,writeJson,now} from './util.mjs';
import {stateDir} from './store.mjs';
const STATE_SCHEMA='agent-sdlc/state/v1';
export function compatCheck(root,projectRoot){
  const version=readJson(path.join(root,'agent-sdlc.manifest.json')).version;const d=stateDir(projectRoot);const legacy=path.join(projectRoot,'.ai-workflow');
  if(!fs.existsSync(d)){if(fs.existsSync(legacy))return {status:'LEGACY_V2_DETECTED',compatible:false,harness_version:version,action:'Do not auto-convert. Export durable artifacts/confirmed requirements from .ai-workflow, initialize v3, then import them as artifacts.'};return {status:'UNINITIALIZED',compatible:true,harness_version:version,action:'run init'};}
  const metaPath=path.join(d,'state.json');
  if(!fs.existsSync(metaPath))return {status:'MIGRATION_AVAILABLE',compatible:true,harness_version:version,action:'run migrate to add state metadata'};
  const meta=readJson(metaPath);return {status:meta.schema===STATE_SCHEMA?'COMPATIBLE':'INCOMPATIBLE_SCHEMA',compatible:meta.schema===STATE_SCHEMA,harness_version:version,state:meta};
}
export function migrateState(root,projectRoot){
  const check=compatCheck(root,projectRoot);if(check.status==='LEGACY_V2_DETECTED'||check.status==='INCOMPATIBLE_SCHEMA')throw new Error(`automatic migration refused: ${check.status}`);if(check.status==='UNINITIALIZED')throw new Error('project is not initialized');
  const d=stateDir(projectRoot);const metaPath=path.join(d,'state.json');if(fs.existsSync(metaPath))return {status:'NOOP',state:readJson(metaPath)};
  const version=readJson(path.join(root,'agent-sdlc.manifest.json')).version;const projectPath=path.join(d,'project.json');if(fs.existsSync(projectPath))fs.copyFileSync(projectPath,path.join(d,`project.backup-${Date.now()}.json`));const state={schema:STATE_SCHEMA,harness_version:version,created_at:now(),last_migrated_at:now()};writeJson(metaPath,state);return {status:'MIGRATED',state};
}
export const stateSchema=STATE_SCHEMA;
