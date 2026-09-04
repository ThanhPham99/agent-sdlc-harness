#!/usr/bin/env node
// Defence-in-depth PreToolUse guard.
//
// MIRRORED FILE. adapters/hooks/pretool-guard.mjs is authoritative and
// hooks/pretool-guard.mjs is a byte-for-byte copy that
// scripts/validate-root-sync.mjs keeps in step. Edit the adapters/ copy: the
// root copy is the install surface, and scripts/validate-guard.mjs runs the
// adapters/ one, so an edit made only at the root leaves the corpus green
// against code that is not what shipped -- and root-sync then fails. The other
// mirrors are generated and say so in their own banners; this one is written by
// hand, which is why it says so here.
//
// This runs inside the host, before a command reaches a shell, and is the only
// layer that still applies when the model has been talked out of every other
// rule. It is deliberately narrow: it blocks commands that are catastrophic by
// construction and asks for a human on commands that are irreversible or reach
// production. Everything else passes untouched.
//
// Two failure modes matter, and they are not symmetric:
//   MISSED_DESTRUCTIVE  a wipe reaches the shell.
//   FALSE_POSITIVE      an everyday command is blocked, and the operator
//                       learns to switch the guard off. This one is worse,
//                       because it removes the guard entirely.
//
// So classification is token-based, not substring-based: `rm -rf node_modules`
// and `rm -rf /` differ only in their target, and only the target decides.
// evals/guard/cases.json pins both directions; scripts/validate-guard.mjs runs
// this file as a real process against that corpus.
let raw='';for await (const c of process.stdin)raw+=c;
let p={};try{p=JSON.parse(raw||'{}')}catch{process.exit(0)}
const name=p.tool_name||p.toolName||p.toolCall?.name||'';
const input=p.tool_input||p.toolInput||p.toolCall?.args||{};
const command=String(input.command||input.CommandLine||input.script||input.cmd||'');

const SHELL_TOOL=/bash|shell|powershell|pwsh|cmd|command|exec|terminal|process|run/i;
const EDIT_TOOL=/edit|write|replace|patch/i;
const targetFile=String(input.file_path||input.filePath||input.TargetFile||input.path||input.filename||input.file||'');

if(!command&&!targetFile)process.exit(0);
if(command&&!(SHELL_TOOL.test(name)||name===''))process.exit(0);
if(!command&&targetFile&&!EDIT_TOOL.test(name))process.exit(0);

// Quotes carry no meaning for classification: `rm -rf "$HOME"` and `rm -rf $HOME`
// are the same command. Strip them once so every rule below sees one form.
const norm=command.replace(/["'`]/g,'');

// Targets whose recursive deletion destroys the machine, the user account, or
// the working tree wholesale. A path *under* one of these is ordinary work
// (`rm -rf ~/proj/node_modules`) and is not in this set.
const CATASTROPHIC=new Set([
  '/','/*','/.','/bin','/etc','/usr','/var','/home','/root','/boot','/dev','/lib','/opt','/sys','/proc',
  '~','~/*','$home','${home}','$home/*','$userprofile','$env:userprofile','$env:homepath',
  '.','..','.*','./*',
  'c:','c:*','d:','e:',
  '$env:systemdrive','$env:systemroot','$env:windir','$env:appdata','$env:programfiles',
  'c:/windows','c:/users','%userprofile%','%systemdrive%','%windir%'
]);
// Compare lowercased, with Windows separators folded and a trailing separator
// trimmed: `C:\`, `c:/` and `c:` are the same root, and so are `~` and `~/`.
function catastrophic(token){
  const t=String(token||'').toLowerCase().replace(/\\/g,'/');
  return CATASTROPHIC.has(t)||CATASTROPHIC.has(t.replace(/\/+$/,''))||CATASTROPHIC.has(t.replace(/\/+\*$/,'/*'));
}

// System roots, for the rules that judge a single file rather than a recursive
// target. Deliberately excludes `~`, `.` and the Windows profile: a file under
// those is ordinary work, which is the whole reason CATASTROPHIC only matches
// the root itself.
const SYSTEM_ROOTS=['/bin','/boot','/dev','/etc','/lib','/lib64','/opt','/proc','/sbin','/sys','/usr','/var',
  'c:/windows','%windir%','$env:windir'];
function underSystemRoot(token){
  const t=String(token||'').toLowerCase().replace(/\\/g,'/');
  return SYSTEM_ROOTS.some(r=>t===r||t.startsWith(`${r}/`));
}

// Wrappers that prefix a real command without changing what it does.
const WRAPPER=/^(?:sudo|doas|su|env|nohup|time|timeout|command|builtin|exec|xargs|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|bash|sh|zsh|\/c|\/k|-c|-command|-noprofile|-executionpolicy|bypass|unrestricted|-file|--)$/i;

const hasFlag=(flags,short,long)=>flags.some(f=>
  (long&&new RegExp(`^--${long}$`,'i').test(f))||
  (short&&new RegExp(`^-[^-]*${short}[^-]*$`).test(f))||
  (short&&new RegExp(`^/${short}$`,'i').test(f)));

const findings=[];
const flag=(decision,rule,detail)=>findings.push({decision,rule,detail});

// Test file detector and test preservation guard
const TEST_FILE_PATTERN=/(?:^|[/\\])(?:tests?|__tests?__)[/\\]|(?:\.|\b)(?:test|spec)\.[a-z0-9]+$|_test\.[a-z0-9]+$|[A-Z][a-zA-Z0-9]*Test\.[a-z0-9]+$/i;
const isTestFile=t=>TEST_FILE_PATTERN.test(String(t||'').replace(/\\/g,'/'));

const testProtectionActive=process.env.AGENT_SDLC_TEST_PROTECTION==='1'||
  ['bug-fix','hotfix'].includes(process.env.AGENT_SDLC_WORKFLOW);

if(testProtectionActive&&targetFile&&isTestFile(targetFile)){
  flag('deny','test-file-mutation-denied',`modifying test file ${targetFile} is denied during fix task; fix implementation code instead`);
}

// Plan scope guard (advisory warning requiring confirmation)
const planScopeEnv=process.env.AGENT_SDLC_TASK_FILES;
if(planScopeEnv&&targetFile){
  const allowed=planScopeEnv.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const normTarget=targetFile.toLowerCase().replace(/\\/g,'/');
  const inScope=allowed.some(f=>normTarget.endsWith(f)||f.endsWith(normTarget));
  if(!inScope&&allowed.length>0){
    flag('ask','plan-scope-drift',`file ${targetFile} is outside declared task plan scope; confirm modification or update plan`);
  }
}

// --- whole-command rules ----------------------------------------------------
// These read the command as one string because the risk lives in the shape of
// the pipeline or in embedded SQL, not in a single argv.

// Remote script piped straight into an interpreter: unreviewed code execution.
if(/\b(?:curl|wget|iwr|invoke-webrequest)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b/i.test(norm)||/\biex\s*\(/i.test(norm))
  flag('ask','remote-script-execution','a downloaded script would run unreviewed');

// A shell function that pipes itself into its own background copy: the only
// thing it can do is exhaust the process table. Matched on the recursion shape
// rather than the `:(){ :|:& };:` spelling, so renaming the function does not
// evade it, and the backreference is what keeps an ordinary function definition
// out of it.
if(/([:\w.-]+)\s*\(\s*\)\s*\{[^{}]*\|\s*\1\s*&[^{}]*\}\s*;?\s*\1/.test(norm))
  flag('deny','fork-bomb','a self-replicating shell function would exhaust the process table');

if(/\bdrop\s+(?:database|schema)\b/i.test(norm))flag('deny','sql-drop-database','irreversible loss of a whole database');
if(/\btruncate\s+table\b/i.test(norm))flag('ask','sql-truncate-table','irreversible table-wide delete');
if(/\bdelete\s+from\s+\w+\s*(?:;|$)/i.test(norm))flag('ask','sql-delete-without-where','delete with no WHERE clause');
if(/\bprisma\s+migrate\s+reset\b|\bsupabase\s+db\s+reset\b|\bdjango-admin\s+flush\b|\brails\s+db:drop\b/i.test(norm))
  flag('deny','orm-database-reset','framework command that drops and recreates the database');

// Exfiltration of environment variables / credentials directly to network tools
if(/\b(?:printenv|env)\b[^|;\n]*\|\s*(?:curl|wget|nc|ncat|netcat|iwr|invoke-webrequest|invoke-restmethod)\b/i.test(norm)||
   /\b(?:get-childitem\s+env:|dir\s+env:|ls\s+env:)\b[^|;\n]*\|\s*(?:curl|wget|iwr|invoke-webrequest|invoke-restmethod)\b/i.test(norm))
  flag('deny','env-credential-exfiltration','dumping environment variables directly into a network transfer tool risks leaking credentials');

// Infrastructure, release and production surfaces. Irreversible or externally
// visible: a human decides, the guard only stops to ask.
const ASK_PATTERNS=[
  [/\bterraform\s+(?:apply|destroy)\b/i,'terraform-mutation'],
  [/\bpulumi\s+(?:up|destroy)\b/i,'pulumi-mutation'],
  [/\bkubectl\s+(?:apply|delete|replace|rollout|scale|drain|cordon|patch)\b/i,'kubectl-mutation'],
  [/\bhelm\s+(?:install|upgrade|uninstall|delete|rollback)\b/i,'helm-release-mutation'],
  [/\b(?:aws|gcloud|az)\b[^\n]*(?:deploy|delete|terminate|destroy|update|create)\b/i,'cloud-cli-mutation'],
  [/\baws\s+s3\s+(?:rb|rm)\b/i,'s3-bucket-or-object-removal'],
  [/\bnpm\s+(?:publish|unpublish)\b/i,'package-publish'],
  [/\b(?:pip|twine)\s+upload\b/i,'package-publish'],
  [/\bcargo\s+publish\b/i,'package-publish'],
  [/\bdocker\s+push\b/i,'image-publish'],
  [/\bdocker\s+system\s+prune\b/i,'docker-wide-prune'],
  [/\b(?:vercel|netlify|flyctl|fly|railway)\b[^\n]*(?:--prod|deploy)\b/i,'hosting-deploy'],
  [/\bsystemctl\s+(?:stop|disable|mask)\b/i,'service-stop'],
  [/\b(?:stop-service|restart-service)\b/i,'service-stop'],
  [/\b(?:stop-computer|restart-computer|shutdown)\b/i,'host-power-state'],
  [/\bset-executionpolicy\b/i,'execution-policy-change'],
  [/\bnet\s+(?:stop|user)\b/i,'windows-service-or-account-change'],
  [/\bsc\s+delete\b/i,'windows-service-delete']
];
for(const [rx,rule] of ASK_PATTERNS)if(rx.test(norm))flag('ask',rule,'production or irreversible operation');

// Disk and filesystem destruction: no target refinement makes these safe.
const DENY_PATTERNS=[
  [/\bmkfs(?:\.|\s)/i,'filesystem-format'],
  [/\bdd\s+[^\n]*\bof=\/dev\//i,'raw-write-to-block-device'],
  [/\b(?:format-volume|clear-disk|initialize-disk|remove-partition|clear-content\s+-path\s+c:)\b/i,'windows-disk-destruction'],
  [/\bformat\s+[a-z]:\s/i,'windows-volume-format'],
  [/\bdiskpart\b[^\n]*\bclean\b/i,'windows-disk-clean'],
  [/>\s*\/dev\/(?:sd|nvme|hd)[a-z0-9]*/i,'redirect-over-block-device']
];
for(const [rx,rule] of DENY_PATTERNS)if(rx.test(norm))flag('deny',rule,'unrecoverable destruction of a disk or filesystem');

// --- per-segment argv rules -------------------------------------------------
// Split the pipeline so `rm` in one segment is judged on its own arguments.
for(const rawSeg of norm.split(/(?:\|\||&&|[;|&\n])/)){
  let tokens=rawSeg.trim().split(/\s+/).filter(Boolean);
  while(tokens.length&&WRAPPER.test(tokens[0]))tokens=tokens.slice(1);
  if(!tokens.length)continue;
  const cmd=tokens[0].toLowerCase().replace(/^.*[\\/]/,'');
  const rest=tokens.slice(1);
  // A leading `-` is a flag everywhere. A leading `/` is a flag only in the
  // DOS switch shape (`/s`, `/q`, `/a:d`) — `/`, `/*` and `/usr` are paths, and
  // misreading those as flags is exactly how `rm -rf /` slips through.
  const isFlag=t=>/^-/.test(t)||/^\/[a-zA-Z](?::\w+)?$/.test(t);
  const flags=rest.filter(isFlag);
  const targets=rest.filter(t=>!isFlag(t));
  const sub=(rest[0]||'').toLowerCase();

  if(cmd==='rm'||cmd==='unlink'){
    const recursive=hasFlag(flags,'[rR]','recursive')||flags.some(f=>/^--recursive$/i.test(f));
    const force=hasFlag(flags,'f','force');
    if(recursive&&targets.some(catastrophic))
      flag('deny','rm-recursive-catastrophic-target',`rm would recursively delete ${targets.find(catastrophic)}`);
    else if(recursive&&force&&targets.some(t=>/^\*$/.test(t)))
      flag('ask','rm-recursive-wildcard','recursive delete of every entry in the working directory');
    else if(testProtectionActive&&targets.some(isTestFile))
      flag('deny','test-file-mutation-denied',`deleting test file ${targets.find(isTestFile)} is denied during fix task; fix implementation code instead`);
  }
  // `find <root> -delete` and `find <root> -exec rm -rf {} \;` destroy exactly
  // what `rm -rf <root>` does, and `find` was not a verb this guard knew at all.
  // A model told to clean up build output reaches for it readily, and one wrong
  // root wipes the machine.
  //
  // Both halves are required. The target test is the same one `rm` uses, so
  // `find ./build -delete` stays ordinary work; the action test is what keeps
  // `find . -name '*.log'` -- a read-only search whose target is in the
  // catastrophic set -- from being blocked.
  if(cmd==='find'){
    const deletes=flags.some(f=>/^-delete$/i.test(f));
    const execs=flags.some(f=>/^-(?:exec|execdir|ok|okdir)$/i.test(f))
      &&rest.some(t=>/^(?:rm|shred|unlink|truncate|dd)$/i.test(t.replace(/^.*[\\/]/,'')));
    if((deletes||execs)&&targets.some(catastrophic))
      flag('deny','find-delete-catastrophic-target',`find would delete everything under ${targets.find(catastrophic)}`);
  }
  if((cmd==='chmod'||cmd==='chown')&&hasFlag(flags,'[rR]','recursive')&&targets.some(catastrophic))
    flag('deny','permission-change-catastrophic-target','recursive ownership/permission change over a system root');
  if(cmd==='shred'&&targets.some(t=>/^\/dev\//i.test(t)))
    flag('deny','shred-block-device','overwrites a raw device');
  // A single file under a system root is not the "path *under* a catastrophic
  // target is ordinary work" case that CATASTROPHIC is written around: nothing
  // routine shreds /etc/passwd. Scoped to system roots only, so `shred
  // ~/id_rsa` and `truncate -s 0 ./app.log` stay untouched.
  if(cmd==='shred'&&targets.some(underSystemRoot))
    flag('deny','shred-system-file',`unrecoverable overwrite of ${targets.find(underSystemRoot)}`);
  if(cmd==='truncate'&&flags.some(f=>/^(?:-s|--size)$/i.test(f)||/^-s0$/i.test(f))
    &&rest.some(t=>/^0$/.test(t))&&targets.some(underSystemRoot))
    flag('ask','truncate-system-file',`would empty ${targets.find(underSystemRoot)}`);
  if(cmd==='git'&&sub==='clean'){
    const f=hasFlag(flags,'f','force');
    if(f&&(hasFlag(flags,'d')||hasFlag(flags,'x')))
      flag('deny','git-clean-untracked-wipe','deletes untracked and ignored files with no recovery path');
  }
  if(cmd==='git'&&sub==='push'){
    const forced=flags.some(f=>/^--force$/i.test(f))||hasFlag(flags,'f');
    if(forced&&!flags.some(f=>/^--force-with-lease/i.test(f)))
      flag('ask','git-push-force','force-push can discard published history');
  }
  if(cmd==='git'&&sub==='reset'&&flags.some(f=>/^--hard$/i.test(f)))
    flag('ask','git-reset-hard','discards uncommitted work irrecoverably');
  if(cmd==='remove-item'||cmd==='ri'){
    const recursive=flags.some(f=>/^-r(?:ecurse)?$/i.test(f));
    const force=flags.some(f=>/^-f(?:orce)?$/i.test(f));
    if(recursive&&targets.some(catastrophic))
      flag('deny','remove-item-catastrophic-target','recursive Remove-Item over a system or profile root');
    else if(recursive&&force)
      flag('ask','remove-item-recursive-force','recursive forced delete with no confirmation');
  }
  if(cmd==='rd'||cmd==='rmdir'){
    const quietRecursive=hasFlag(flags,'s')&&hasFlag(flags,'q');
    if(targets.some(catastrophic))flag('deny','rmdir-catastrophic-target','directory removal over a system or profile root');
    else if(quietRecursive)flag('ask','rmdir-quiet-recursive','silent recursive directory removal');
  }
}

// deny outranks ask; the first matching rule of the winning severity explains it.
const winner=findings.find(f=>f.decision==='deny')||findings.find(f=>f.decision==='ask')||null;
if(winner){
  const prefix=winner.decision==='deny'
    ?'Agent SDLC guard blocked an obviously destructive command'
    :'Agent SDLC guard requires human confirmation for a production/irreversible command';
  console.log(JSON.stringify({hookSpecificOutput:{
    hookEventName:'PreToolUse',
    permissionDecision:winner.decision,
    permissionDecisionReason:`${prefix} [${winner.rule}]: ${winner.detail}.`
  }}));
}
