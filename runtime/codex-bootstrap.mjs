// Managed Codex bootstrap.
//
// Codex builds its instruction chain from `$CODEX_HOME/AGENTS.override.md` when it
// exists, otherwise `$CODEX_HOME/AGENTS.md`, before repository-level AGENTS.md files.
// This module owns exactly one delimited block inside the global AGENTS.md:
// idempotent to install, reversible to remove, byte-preserving outside the block.
// It never edits a repository-local AGENTS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BOOTSTRAP_TEXT,bootstrapHash,getActivationPolicy} from './activation.mjs';

export const START='<!-- agent-sdlc:auto-bootstrap:start';
export const END='<!-- agent-sdlc:auto-bootstrap:end -->';
const BLOCK_RE=/[ \t]*<!-- agent-sdlc:auto-bootstrap:start[^>]*-->[\s\S]*?<!-- agent-sdlc:auto-bootstrap:end -->[ \t]*\r?\n?/g;

export function codexHome(explicit=null){
  return path.resolve(explicit||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
}
function paths(home){
  const policy=getActivationPolicy();
  const h=codexHome(home);
  return {
    home:h,
    instructions:path.join(h,policy.hosts.codex.managed_instruction_file),
    override:path.join(h,policy.hosts.codex.managed_override_file),
    ledger:path.join(h,'agent-sdlc-bootstrap.json')
  };
}
function block(version){
  return `${START} version=${version} hash=${bootstrapHash()} -->\n${BOOTSTRAP_TEXT}\n${END}`;
}
function readLedger(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch{return null;}}
function writeAtomic(target,text){
  const tmp=`${target}.agent-sdlc.tmp`;
  const fd=fs.openSync(tmp,'w');
  try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(tmp,target);
}
function normalizeEol(text,crlf){return crlf?text.replace(/\r?\n/g,'\r\n'):text;}

export function status({home=null,version=null}={}){
  const p=paths(home);
  const exists=fs.existsSync(p.instructions);
  const text=exists?fs.readFileSync(p.instructions,'utf8'):'';
  const blocks=(text.match(BLOCK_RE)||[]).length;
  const masked=fs.existsSync(p.override);
  const ledger=readLedger(p.ledger);
  const installedVersion=(text.match(/agent-sdlc:auto-bootstrap:start version=([^\s]+)/)||[])[1]||null;
  const currentHash=(text.match(/agent-sdlc:auto-bootstrap:start[^>]*hash=(sha256:[0-9a-f]+)/)||[])[1]||null;
  const warnings=[];
  if(masked)warnings.push('AGENTS.override.md takes precedence over AGENTS.md; the managed block is masked');
  if(blocks>1)warnings.push(`${blocks} managed blocks present; install repairs to a single block`);
  if(blocks&&currentHash&&currentHash!==bootstrapHash())warnings.push('managed block text is stale; run install to refresh');
  return {
    schema:'agent-sdlc/codex-bootstrap-status/v1',
    version,
    codex_home:p.home,
    instruction_file:p.instructions,
    instruction_file_exists:exists,
    installed:blocks>0,
    blocks,
    installed_version:installedVersion,
    installed_hash:currentHash,
    current_hash:bootstrapHash(),
    up_to_date:blocks===1&&currentHash===bootstrapHash(),
    masked,
    masked_by:masked?p.override:null,
    created_by_agent_sdlc:!!ledger?.created_instruction_file,
    warnings
  };
}

export function install({home=null,version='0.0.0',dryRun=false}={}){
  const p=paths(home);
  const before=status({home,version});
  const existed=fs.existsSync(p.instructions);
  const original=existed?fs.readFileSync(p.instructions,'utf8'):'';
  const crlf=/\r\n/.test(original);
  const stripped=original.replace(BLOCK_RE,'');
  const body=stripped.replace(/\s+$/,'');
  const managed=block(version);
  const next=normalizeEol(body?`${body}\n\n${managed}\n`:`${managed}\n`,crlf);
  const changed=next!==original;
  const actions=[];
  if(!dryRun&&changed){
    fs.mkdirSync(p.home,{recursive:true});
    const backup=`${p.instructions}.agent-sdlc-backup`;
    if(existed&&!fs.existsSync(backup)){fs.copyFileSync(p.instructions,backup);actions.push(`backup:${backup}`);}
    writeAtomic(p.instructions,next);
    actions.push(existed?'block_written':'instruction_file_created');
    const ledger=readLedger(p.ledger)||{};
    fs.writeFileSync(p.ledger,JSON.stringify({
      schema:'agent-sdlc/codex-bootstrap-ledger/v1',
      created_instruction_file:ledger.created_instruction_file??!existed,
      bootstrap_hash:bootstrapHash(),
      version
    },null,2)+'\n');
  }
  return {
    schema:'agent-sdlc/codex-bootstrap-install/v1',
    status:dryRun?'DRY_RUN':(changed?'INSTALLED':'ALREADY_CURRENT'),
    dry_run:!!dryRun,
    changed:dryRun?false:changed,
    would_change:changed,
    actions,
    blocks_before:before.blocks,
    ...status({home,version})
  };
}

export function uninstall({home=null,version='0.0.0',dryRun=false}={}){
  const p=paths(home);
  if(!fs.existsSync(p.instructions)){
    return {schema:'agent-sdlc/codex-bootstrap-uninstall/v1',status:'NOT_PRESENT',dry_run:!!dryRun,changed:false,removed_file:false,...status({home,version})};
  }
  const original=fs.readFileSync(p.instructions,'utf8');
  const crlf=/\r\n/.test(original);
  const stripped=original.replace(BLOCK_RE,'');
  const changed=stripped!==original;
  const ledger=readLedger(p.ledger);
  const emptyNow=!stripped.trim();
  // Only a file Agent SDLC created itself may be deleted when nothing else remains.
  const removeFile=emptyNow&&!!ledger?.created_instruction_file;
  if(!dryRun&&changed){
    if(removeFile){fs.rmSync(p.instructions,{force:true});fs.rmSync(p.ledger,{force:true});}
    else writeAtomic(p.instructions,normalizeEol(stripped.replace(/\s+$/,'')+'\n',crlf));
  }
  return {
    schema:'agent-sdlc/codex-bootstrap-uninstall/v1',
    status:dryRun?'DRY_RUN':(changed?'REMOVED':'NOT_PRESENT'),
    dry_run:!!dryRun,
    changed:dryRun?false:changed,
    would_change:changed,
    removed_file:dryRun?false:removeFile,
    preserved_user_content:!removeFile&&!emptyNow,
    ...status({home,version})
  };
}
