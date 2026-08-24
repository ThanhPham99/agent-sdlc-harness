#!/usr/bin/env node
// Thin wrapper over runtime/codex-bootstrap.mjs so installers and CI can manage the
// Codex global bootstrap block without depending on the packaged CLI entrypoint.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as bootstrap from '../runtime/codex-bootstrap.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=JSON.parse(fs.readFileSync(path.join(ROOT,'agent-sdlc.manifest.json'),'utf8')).version;
const argv=process.argv.slice(2);
const action=argv.find(a=>!a.startsWith('--'))||'status';
const val=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:null;};
const opts={home:val('--codex-home'),version,dryRun:argv.includes('--dry-run')};
let out;
if(action==='install')out=bootstrap.install(opts);
else if(action==='uninstall')out=bootstrap.uninstall(opts);
else if(action==='status')out=bootstrap.status(opts);
else{console.error(`usage: codex-bootstrap.mjs status|install|uninstall [--codex-home DIR] [--dry-run]`);process.exit(2);}
console.log(JSON.stringify(out,null,2));
// Masking is reported as a warning in the payload, not as a process failure, so
// installers running under `set -e` do not abort on a recoverable diagnosis.
for(const w of out.warnings||[])console.error(`[codex-bootstrap] warning: ${w}`);
