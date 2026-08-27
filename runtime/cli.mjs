#!/usr/bin/env node
// The CLI entry point: argument parsing, one context, one dispatch, one error
// contract. Nothing else.
//
// This file used to be the whole CLI -- 46 commands in a single if/else chain
// inside one try block, the largest module in the runtime and the least covered
// of them. Nothing in it could be reached without spawning a process, and the
// help text listing every command sat at the bottom of the same chain, kept
// honest by a regex. The commands now live in runtime/commands/, one group per
// module, and runtime/commands/index.mjs is the registry both the dispatcher and
// the generated help read.
//
// The contract every command keeps, and the reason this stays one small file:
//   stdout is JSON (or the help text), and nothing else;
//   a failure exits non-zero with a structured {status:'ERROR',error} document
//   rather than a stack trace;
//   an unknown command prints help and exits 2, no command exits 0.
import path from 'node:path';
import {parseArgs,readJson,rootFrom} from './util.mjs';
import {COMMANDS,loadCommand,renderHelp} from './commands/index.mjs';

const ROOT=rootFrom(import.meta.url);
const args=parseArgs(process.argv.slice(2));
const cmd=args._[0];
const projectRoot=path.resolve(args.project||process.cwd());
const print=x=>console.log(typeof x==='string'?x:JSON.stringify(x,null,2));

// A required flag. Sixteen call sites used to guard their own arguments this
// way; the commands that did not each turned a missing flag into something that
// reads like a real answer:
//   tool-run  without --tool  -> {"status":"DENY","reason":"UNKNOWN_TOOL"}, exit 0,
//                                indistinguishable from a policy refusal.
//   transition without --to   -> "state undefined not in workflow new-feature",
//                                an orchestrator internal leaking outward.
//   artifact-get without --ref-> "Cannot read properties of undefined".
// A missing argument is an argument error, and every command now says so the
// same way --run-id already did.
function need(flag){
  const v=args[flag];
  if(v===undefined||v===null||v==='')throw new Error(`--${flag} required`);
  return v;
}

async function needRun(){
  const runId=need('run-id');
  const {loadRun}=await import('./store.mjs');
  return loadRun(projectRoot,runId);
}

/** Everything a handler is allowed to reach. Handlers take this and print. */
const ctx={args,ROOT,projectRoot,print,need,needRun};

async function main(){
  try{
    const handler=cmd?await loadCommand(cmd):null;
    if(!handler){
      print(renderHelp(readJson(path.join(ROOT,'agent-sdlc.manifest.json')).version));
      // An unknown command is a caller error; no command at all is a help
      // request. Scripts depend on telling those apart.
      process.exit(cmd?2:0);
    }
    await handler(ctx);
  }catch(e){
    console.error(JSON.stringify({status:'ERROR',error:e.message},null,2));
    process.exit(1);
  }
}

main();

export {COMMANDS};
