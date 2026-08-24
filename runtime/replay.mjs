import fs from 'node:fs';
import path from 'node:path';
import {dirtyHash,gitSha,readJson,sha256,writeJson} from './util.mjs';
import {stateDir} from './store.mjs';
export function exportReplay(projectRoot,run){const eventPath=path.join(stateDir(projectRoot),'events',`${run.run_id}.jsonl`);const events=fs.existsSync(eventPath)?fs.readFileSync(eventPath,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];return {schema:'agent-sdlc/replay-bundle/v1',run,environment:{git_sha:gitSha(projectRoot),dirty_diff_hash:dirtyHash(projectRoot),node:process.version,platform:process.platform,arch:process.arch},events,event_stream_sha256:sha256(events.map(JSON.stringify).join('\n'))};}
export function validateReplay(bundle){const calc=sha256((bundle.events||[]).map(JSON.stringify).join('\n'));return {valid:calc===bundle.event_stream_sha256,expected:bundle.event_stream_sha256,actual:calc,event_count:(bundle.events||[]).length};}
