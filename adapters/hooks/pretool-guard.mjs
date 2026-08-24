#!/usr/bin/env node
import fs from 'node:fs';
let raw='';for await (const c of process.stdin)raw+=c;
let p={};try{p=JSON.parse(raw||'{}')}catch{process.exit(0)}
const name=p.tool_name||p.toolName||p.toolCall?.name||'';
const input=p.tool_input||p.toolInput||p.toolCall?.args||{};
const command=String(input.command||input.CommandLine||'');
const deny=[/\brm\s+-rf\s+\/(?:\s|$)/i,/\bmkfs(?:\.|\s)/i,/\bdd\s+if=.*\bof=\/dev\//i,/\bDROP\s+DATABASE\b/i,/\bgit\s+clean\s+-[^\n]*[fdx][^\n]*[fdx]/i];
const ask=[/\bkubectl\s+(?:apply|delete|replace|rollout|scale)\b/i,/\bterraform\s+(?:apply|destroy)\b/i,/\b(?:aws|gcloud|az)\b[^\n]*(?:deploy|delete|terminate|destroy|update|create)\b/i,/\bgit\s+push\b[^\n]*--force/i,/\bnpm\s+publish\b/i,/\bdocker\s+push\b/i,/\bvercel\b[^\n]*--prod\b/i];
let decision=null,reason='';
if(/bash|shell|command|exec/i.test(name)||command){
  if(deny.some(r=>r.test(command))){decision='deny';reason='Agent SDLC guard blocked an obviously destructive command.';}
  else if(ask.some(r=>r.test(command))){decision='ask';reason='Agent SDLC guard requires human confirmation for a production/irreversible command.';}
}
if(decision)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:reason}}));
