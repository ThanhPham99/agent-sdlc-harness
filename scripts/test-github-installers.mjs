#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-install-test-'));
const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
const log=path.join(tmp,'calls.log');
const toBashPath=(p)=>p.replace(/^([A-Za-z]):/,(_,d)=>`/mnt/${d.toLowerCase()}`).replace(/\\/g,'/');
const logPosix=toBashPath(log);
const binPosix=toBashPath(bin);
function fake(name){
  const body=`#!/usr/bin/env bash\necho '${name} '"$*" >> "${logPosix}"\nif [[ "$1 $2 $3" == "plugin marketplace list" ]]; then exit 0; fi\nexit 0\n`;
  fs.writeFileSync(path.join(bin,name),body,{mode:0o755});
}
for(const n of ['claude','codex','agy'])fake(n);
spawnSync('bash',['-c',`chmod +x "${binPosix}"/*`]);
const r=spawnSync('bash',['-c',`export PATH="${binPosix}:$PATH"; ./install.sh --repo ThanhPham99/agent-sdlc-harness --host all`],{cwd:ROOT,encoding:'utf8'});
if(r.status!==0)throw new Error(`install script failed ${r.status}: ${r.stderr}`);
const calls=fs.readFileSync(log,'utf8');
const must=[
  'claude plugin marketplace add ThanhPham99/agent-sdlc-harness',
  'claude plugin install agent-sdlc-harness@agent-sdlc-github',
  'codex plugin marketplace add ThanhPham99/agent-sdlc-harness',
  'codex plugin add agent-sdlc-harness@agent-sdlc-github',
  'agy plugin install https://github.com/ThanhPham99/agent-sdlc-harness'
];
for(const x of must)if(!calls.includes(x))throw new Error(`missing invocation: ${x}\n${calls}`);
const u=spawnSync('bash',['-c',`PATH="${binPosix}:$PATH" ./uninstall.sh --host all`],{cwd:ROOT,encoding:'utf8'});
if(u.status!==0)throw new Error(`uninstall failed ${u.status}: ${u.stderr}`);
const calls2=fs.readFileSync(log,'utf8');
for(const x of ['claude plugin uninstall agent-sdlc-harness@agent-sdlc-github','codex plugin remove agent-sdlc-harness@agent-sdlc-github','agy plugin uninstall agent-sdlc-harness']) if(!calls2.includes(x))throw new Error(`missing uninstall invocation: ${x}`);
console.log(JSON.stringify({schema:'agent-sdlc/github-installer-regression/v1',status:'PASS',repo:'ThanhPham99/agent-sdlc-harness',install_invocations:must.length,uninstall_invocations:3},null,2));
