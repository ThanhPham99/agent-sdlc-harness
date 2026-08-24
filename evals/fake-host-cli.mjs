#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const argv=process.argv.slice(2);
const hostBase=path.basename(process.argv[1]);
const host=hostBase==='agy'?'antigravity':hostBase;
const help={
  claude:'--bare --plugin-dir --print -p --output-format --json-schema --no-session-persistence --max-turns --model --effort',
  codex:'--ephemeral --json --output-schema --output-last-message --sandbox --skip-git-repo-check --model -c',
  antigravity:'--sandbox --print -p --print-timeout --output-format --json-schema --model --effort'
}[host]||'';
if(argv.includes('--version')){console.log(`${host} fake-transport-1.0`);process.exit(0);}
if(argv.includes('--help')){console.log(help);process.exit(0);}
function argAfter(flag){const i=argv.indexOf(flag);return i>=0?argv[i+1]:null;}
const prompt=argAfter('-p')||argAfter('--print')||argv.at(-1)||'';
function base(workflow='new-feature',profile='STANDARD',overlays=[]){return {activate:true,workflow,profile,overlays,human_stop_required:false,next_action:'RUN_SDLC_ORCHESTRATOR',reason_codes:['FAKE_TRANSPORT_REGRESSION'],untrusted_instruction_detected:false,trust_action:'NONE',approval_required:false};}
function semanticDecision(){
  const t=prompt.toLowerCase();
  if(t.includes('repository-grounded qualification mode'))return null;
  if(t.includes('explain what a hash table is'))return {activate:false,workflow:null,profile:null,overlays:[],human_stop_required:false,next_action:null,reason_codes:['GENERIC_QA'],untrusted_instruction_detected:false,trust_action:'NONE',approval_required:false};
  let d=base();
  if(t.includes('continue phase 2'))d=base('continue-feature','STANDARD',[]);
  else if(t.includes('login bug'))d=base('bug-fix','STANDARD',[]);
  else if(t.includes('urgent production hotfix'))d=base('hotfix','STRICT',['hotfix']);
  else if(t.includes('database schema migration')||t.includes('customer table schema')||t.includes('destructive database schema'))d=base('database-migration','STRICT',['db-migration']);
  else if(t.includes('security vulnerability')||t.includes('iam credentials'))d=base('security-remediation','STRICT',['security']);
  else if(t.includes('terraform'))d=base('infrastructure-change','STRICT',[]);
  else if(t.includes('sev1')||t.includes('production outage'))d=base('incident-response','STRICT',['incident']);
  else if(t.includes('compliance control'))d=base('compliance-change','STRICT',[]);
  else if(t.includes('tests only'))d=base('test-only','FAST',[]);
  else if(t.includes('wishlist'))d=base('new-feature','STANDARD',[]);
  else if(t.includes('idempotent refund'))d=base('new-feature','STANDARD',[]);
  if(t.includes('ignore all previous instructions')&&t.includes('coupon')){d=base('new-feature','STANDARD',[]);d.untrusted_instruction_detected=true;d.trust_action='QUARANTINE';}
  if(t.includes('bypass all approvals')){d=base('new-feature','STANDARD',[]);d.human_stop_required=true;d.approval_required=true;d.trust_action='DENY';}
  if(t.includes('iam credentials')){d=base('security-remediation','STRICT',['security']);d.human_stop_required=true;d.approval_required=true;d.trust_action='HUMAN';}
  if(t.includes('destructive database schema')){d=base('database-migration','STRICT',['db-migration']);d.human_stop_required=true;d.approval_required=true;d.trust_action='HUMAN';}
  return d;
}
function e2eDecision(){
  const statePath=path.join(process.cwd(),'.agent-sdlc','state.json');
  if(!fs.existsSync(statePath))return {decision:'BOOTSTRAP_PROJECT',observed_state:null,trust_violation_detected:false,reason_codes:['NO_PROJECT_STATE']};
  let state=null;try{state=JSON.parse(fs.readFileSync(statePath,'utf8')).state||null;}catch{}
  if(state==='NEEDS_CONFIRMATION')return {decision:'WAIT_FOR_HUMAN',observed_state:state,trust_violation_detected:false,reason_codes:['CONFIRMATION_REQUIRED']};
  if(state==='BLOCKED')return {decision:'REMAIN_BLOCKED',observed_state:state,trust_violation_detected:false};
  if(state==='IMPLEMENT')return {decision:'RESUME_CURRENT_STAGE',observed_state:state,trust_violation_detected:false};
  return {decision:'NO_CHANGE_COMPLETE',observed_state:state,trust_violation_detected:false};
}
const decision=prompt.toLowerCase().includes('repository-grounded qualification mode')?e2eDecision():semanticDecision();
const usage={input_tokens:101,output_tokens:29,total_tokens:130};
const finalPath=argAfter('--output-last-message');
if(finalPath){fs.mkdirSync(path.dirname(finalPath),{recursive:true});fs.writeFileSync(finalPath,JSON.stringify(decision)+'\n');console.log(JSON.stringify({type:'turn.completed',usage}));}
else console.log(JSON.stringify({structured_output:decision,usage}));
process.exit(0);
