#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BOOTSTRAP_TEXT} from '../runtime/activation.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-install-test-'));
const bin=path.join(tmp,'bin');fs.mkdirSync(bin);
const log=path.join(tmp,'calls.log');
// Windows paths have to be handed to the POSIX shell in that shell's own
// vocabulary, and the vocabularies differ: Git Bash/MSYS mounts D: at /d, WSL at
// /mnt/d, Cygwin at /cygdrive/d. Hard-coding /mnt/<drive> made every path the
// fake host CLIs wrote invisible to the test that read it back, so this suite
// failed on Windows for a reason that had nothing to do with the installers.
// Ask the shell rather than guessing: cygpath knows, and when it is absent the
// /mnt probe separates WSL from MSYS.
const bashPathStyle=(()=>{
  if(process.platform!=='win32')return 'posix';
  if(spawnSync('bash',['-c','command -v cygpath >/dev/null'],{encoding:'utf8'}).status===0)return 'cygpath';
  const mnt=spawnSync('bash',['-c','test -d /mnt/c && echo mnt || echo msys'],{encoding:'utf8'});
  return (mnt.stdout||'').trim()==='mnt'?'wsl':'msys';
})();
const toBashPath=(p)=>{
  if(bashPathStyle==='posix')return p;
  if(bashPathStyle==='cygpath'){
    // Pass through the environment: a Windows path inside a shell-quoted string
    // loses its backslashes before cygpath ever sees it.
    const r=spawnSync('bash',['-c','cygpath -u "$AGENT_SDLC_WINPATH"'],
      {encoding:'utf8',env:{...process.env,AGENT_SDLC_WINPATH:p}});
    const out=(r.stdout||'').trim();
    if(out)return out;
  }
  const prefix=bashPathStyle==='wsl'?'/mnt/':'/';
  return p.replace(/^([A-Za-z]):/,(_,d)=>`${prefix}${d.toLowerCase()}`).replace(/\\/g,'/');
};
const logPosix=toBashPath(log);
const binPosix=toBashPath(bin);
function fake(name){
  const body=`#!/usr/bin/env bash\necho '${name} '"$*" >> "${logPosix}"\nif [[ "$1 $2 $3" == "plugin marketplace list" ]]; then exit 0; fi\nexit 0\n`;
  fs.writeFileSync(path.join(bin,name),body,{mode:0o755});
}
for(const n of ['claude','codex','agy'])fake(n);
spawnSync('bash',['-c',`chmod +x "${binPosix}"/* "${toBashPath(ROOT)}"/*.sh "${toBashPath(ROOT)}"/bin/* 2>/dev/null || true`]);
function bash(script,env={}){
  const exports=Object.entries(env).map(([k,v])=>`export ${k}="${toBashPath(v)}";`).join(' ');
  return spawnSync('bash',['-c',`export PATH="${binPosix}:$PATH"; ${exports} ${script}`],{cwd:ROOT,encoding:'utf8'});
}
const codexHome=(name)=>{const d=path.join(tmp,name);fs.mkdirSync(d,{recursive:true});return d;};
const agentsMd=(home)=>path.join(home,'AGENTS.md');
const hasBootstrap=(home)=>fs.existsSync(agentsMd(home))&&fs.readFileSync(agentsMd(home),'utf8').includes(BOOTSTRAP_TEXT);
const assert=(v,m)=>{if(!v)throw new Error(m);};
// The installer shells out to `node` from inside the POSIX shell. On a machine whose
// shell node predates the engine floor (>=18) the managed-bootstrap steps cannot run,
// so those assertions are reported as skipped instead of being faked as passes.
const shellNode=(()=>{
  const r=spawnSync('bash',['-c','node -v'],{encoding:'utf8'});
  const major=Number(String(r.stdout||'').trim().replace(/^v/,'').split('.')[0]);
  return {version:(r.stdout||'').trim()||null,usable:Number.isFinite(major)&&major>=18};
})();
const bootstrapAssert=(v,m)=>{if(shellNode.usable)assert(v,m);};

// 1. Default install: plugin registration plus the managed Codex bootstrap.
const home1=codexHome('codex-default');
const r=bash('./install.sh --repo ThanhPham99/agent-sdlc-harness --host all',{CODEX_HOME:home1});
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
bootstrapAssert(hasBootstrap(home1),'default install did not write the managed Codex bootstrap');

if(shellNode.usable){
  // 2. Re-running is idempotent.
  const before=fs.readFileSync(agentsMd(home1),'utf8');
  const again=bash('./install.sh --repo ThanhPham99/agent-sdlc-harness --host codex',{CODEX_HOME:home1});
  assert(again.status===0,`second install failed: ${again.stderr}`);
  assert(fs.readFileSync(agentsMd(home1),'utf8')===before,'second install rewrote AGENTS.md');
  assert((before.match(/agent-sdlc:auto-bootstrap:start/g)||[]).length===1,'duplicate managed block');

  // 3. --no-auto-activate leaves the user's Codex home untouched.
  const home2=codexHome('codex-optout');
  const optOut=bash('./install.sh --repo ThanhPham99/agent-sdlc-harness --host codex --no-auto-activate',{CODEX_HOME:home2});
  assert(optOut.status===0,`opt-out install failed: ${optOut.stderr}`);
  assert(!fs.existsSync(agentsMd(home2)),'--no-auto-activate still wrote AGENTS.md');

  // 4. --dry-run changes nothing, neither host state nor files.
  const home3=codexHome('codex-dryrun');
  fs.writeFileSync(agentsMd(home3),'# mine\n');
  const dry=bash('./install.sh --repo ThanhPham99/agent-sdlc-harness --host codex --dry-run',{CODEX_HOME:home3});
  assert(dry.status===0,`dry-run failed: ${dry.stderr}`);
  assert(fs.readFileSync(agentsMd(home3),'utf8')==='# mine\n','dry-run mutated AGENTS.md');
  assert(/\[dry-run\]/.test(dry.stdout),'dry-run did not report planned actions');

  // 5a. Preserve unrelated user content before uninstalling.
  fs.writeFileSync(agentsMd(home1),'# keep me\n\nmy rule\n'+fs.readFileSync(agentsMd(home1),'utf8'));
}

// 5b. Uninstall removes plugins and only the managed block.
const u=bash('./uninstall.sh --host all',{CODEX_HOME:home1});
if(u.status!==0)throw new Error(`uninstall failed ${u.status}: ${u.stderr}`);
const calls2=fs.readFileSync(log,'utf8');
for(const x of ['claude plugin uninstall agent-sdlc-harness@agent-sdlc-github','codex plugin remove agent-sdlc-harness@agent-sdlc-github','agy plugin uninstall agent-sdlc-harness']) if(!calls2.includes(x))throw new Error(`missing uninstall invocation: ${x}`);
if(shellNode.usable){
  const remaining=fs.readFileSync(agentsMd(home1),'utf8');
  assert(remaining.includes('my rule'),'uninstall removed user content');
  assert(!remaining.includes(BOOTSTRAP_TEXT),'uninstall left the managed bootstrap behind');

  // 6. --keep-bootstrap preserves the managed block.
  const home4=codexHome('codex-keep');
  bash('./install.sh --repo ThanhPham99/agent-sdlc-harness --host codex',{CODEX_HOME:home4});
  const keep=bash('./uninstall.sh --host codex --keep-bootstrap',{CODEX_HOME:home4});
  assert(keep.status===0,`keep-bootstrap uninstall failed: ${keep.stderr}`);
  assert(hasBootstrap(home4),'--keep-bootstrap removed the managed block');
}

fs.rmSync(tmp,{recursive:true,force:true});
const autoCases=['default_installs_codex_bootstrap','idempotent_reinstall','no_auto_activate_opt_out','dry_run_no_mutation','uninstall_removes_only_managed_block','keep_bootstrap'];
console.log(JSON.stringify({
  schema:'agent-sdlc/github-installer-regression/v1',
  status:'PASS',
  repo:'ThanhPham99/agent-sdlc-harness',
  install_invocations:must.length,
  uninstall_invocations:3,
  shell_node:shellNode.version,
  platform:process.platform,
  bash_path_style:bashPathStyle,
  auto_activation_cases:shellNode.usable?autoCases:[],
  auto_activation_status:shellNode.usable?'VERIFIED':'SKIPPED_SHELL_NODE_BELOW_ENGINE_FLOOR',
  skipped_cases:shellNode.usable?[]:autoCases
},null,2));
