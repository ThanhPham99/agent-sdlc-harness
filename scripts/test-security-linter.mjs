import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {lintSecurityRisks} from '../runtime/security-linter.mjs';
import {initProject} from '../runtime/store.mjs';
import {newRun} from '../runtime/orchestrator.mjs';
import {route} from '../runtime/router.mjs';
import {makeTempDir} from './lib/tempdir.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {test,assert,finish}=createSuite('agent-sdlc/security-linter-validation/v1','SECURITY-LINTER-VALIDATION.json');

function fixture(name='auto-test-service'){
  const d=makeTempDir(`agent-sdlc-${name}-`);
  execFileSync('git',['init','-q'],{cwd:d});
  fs.writeFileSync(path.join(d,'README.md'),'# fixture\n');
  execFileSync('git',['add','.'],{cwd:d});
  execFileSync('git',['-c','user.email=test@test.local','-c','user.name=test','commit','-qm','init'],{cwd:d});
  initProject(d,{
    schema:'agent-sdlc/project/v1',
    project:name,
    commands:{
      test_targeted:['node','-e','process.exit(0)'],
      test_full:['node','-e','process.exit(0)']
    },
    test_commands:{
      test_targeted:['node','-e','process.exit(0)'],
      test_full:['node','-e','process.exit(0)']
    }
  });
  return d;
}

await test('security-linter-detects-eval',()=>{
  const code='function run(code) { return eval(code); }';
  const res=lintSecurityRisks(code,{filename:'exec.js'});
  assert(res.clean===false,'should detect eval');
  assert(res.risk_level==='HIGH','should be HIGH risk');
  assert(res.findings.some(f=>f.rule_id==='EVAL_EXECUTION'),'missing EVAL_EXECUTION');
});

await test('security-linter-detects-inner-html-xss',()=>{
  const code='element.innerHTML = "<div>" + userContent + "</div>";';
  const res=lintSecurityRisks(code,{filename:'render.js'});
  assert(res.clean===false,'should detect innerHTML');
  assert(res.findings.some(f=>f.rule_id==='UNSAFE_HTML_INJECTION'),'missing UNSAFE_HTML_INJECTION');
});

await test('security-linter-detects-command-injection',()=>{
  const code='child_process.exec("rm -rf " + targetPath);';
  const res=lintSecurityRisks(code,{filename:'cleanup.js'});
  assert(res.clean===false,'should detect command injection');
  assert(res.findings.some(f=>f.rule_id==='COMMAND_INJECTION_RISK'),'missing COMMAND_INJECTION_RISK');
});

await test('security-linter-detects-prototype-pollution',()=>{
  const code='obj["__proto__"]["admin"] = true;';
  const res=lintSecurityRisks(code,{filename:'merge.js'});
  assert(res.clean===false,'should detect prototype pollution');
  assert(res.findings.some(f=>f.rule_id==='PROTOTYPE_POLLUTION'),'missing PROTOTYPE_POLLUTION');
});

await test('security-linter-detects-hardcoded-secrets',()=>{
  const code='const awsKey = "AKIAIOSFODNN7EXAMPLE"; const ghToken = "ghp_123456789012345678901234567890123456";';
  const res=lintSecurityRisks(code,{filename:'credentials.js'});
  assert(res.clean===false,'should detect hardcoded secrets');
  assert(res.risk_level==='HIGH','should be HIGH risk');
  assert(res.findings.some(f=>f.rule_id==='HARDCODED_SECRET'),'missing HARDCODED_SECRET');
});

await test('security-linter-detects-path-traversal',()=>{
  const code='const fullPath = path.join("/var/data", "../../../etc/passwd"); const data = fs.readFileSync(fullPath);';
  const res=lintSecurityRisks(code,{filename:'reader.js'});
  assert(res.clean===false,'should detect path traversal');
  assert(res.findings.some(f=>f.rule_id==='PATH_TRAVERSAL'),'missing PATH_TRAVERSAL');
});

await test('security-linter-detects-timing-attack',()=>{
  const code='if (userApiKey === serverToken) { return true; }';
  const res=lintSecurityRisks(code,{filename:'auth.js'});
  assert(res.clean===false,'should detect timing attack comparison');
  assert(res.findings.some(f=>f.rule_id==='TIMING_ATTACK'),'missing TIMING_ATTACK');
});

await test('security-linter-detects-insecure-randomness',()=>{
  const code='const sessionToken = Math.random().toString(36).substring(2);';
  const res=lintSecurityRisks(code,{filename:'session.js'});
  assert(res.clean===false,'should detect insecure randomness');
  assert(res.findings.some(f=>f.rule_id==='INSECURE_RANDOMNESS'),'missing INSECURE_RANDOMNESS');
});

await test('security-linter-passes-clean-code',()=>{
  const code='export function add(a, b) { return Number(a) + Number(b); }';
  const res=lintSecurityRisks(code,{filename:'math.js'});
  assert(res.clean===true,'should be clean');
  assert(res.risk_level==='LOW','should be LOW risk');
  assert(res.findings_count===0,'should have 0 findings');
});

await test('security-sast-runs-the-shipped-linter-over-changed-files',async ()=>{
  const {invokeTool}=await import('../runtime/tools.mjs');
  const d=fixture('sast-tool');           // reuse this suite's existing fixture helper
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','risky.js'),'const q = "SELECT * FROM t WHERE id=" + userInput;\neval(userInput);\n');
  const run=newRun(ROOT,d,{objective:'Add lookup',route:route(ROOT,'Add lookup endpoint')});
  run.state='VERIFY';
  const res=invokeTool(ROOT,d,run,'security.sast',{});
  assert(res.status!=='ERROR',`sast must be builtin now, got ${res.status}: ${JSON.stringify(res.summary)}`);
  assert(res.status==='FAIL','a file with eval() and string-built SQL must not pass');
  assert(String(res.summary).includes('src/risky.js'),`the summary must name the file, got ${res.summary}`);
});

await test('security-sast-passes-a-clean-tree',async ()=>{
  const {invokeTool}=await import('../runtime/tools.mjs');
  const d=fixture('sast-clean');
  fs.mkdirSync(path.join(d,'src'),{recursive:true});
  fs.writeFileSync(path.join(d,'src','clean.js'),'export const add=(a,b)=>a+b;\n');
  const run=newRun(ROOT,d,{objective:'Add sum',route:route(ROOT,'Add sum helper')});
  run.state='VERIFY';
  const res=invokeTool(ROOT,d,run,'security.sast',{});
  assert(res.status==='PASS',`a clean tree must pass, got ${res.status}: ${res.summary}`);
});

finish();