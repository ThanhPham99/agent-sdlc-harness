// Temp fixtures that clean themselves up.
//
// Every offline suite works in a throwaway directory under os.tmpdir(). Each
// one created its own with fs.mkdtempSync and was responsible for removing it,
// and 31 of the 35 creation sites had fewer removals than creations. That is
// not a series of oversights: a suite that throws never reaches its cleanup
// line, and a suite that creates a fixture per case can only clean up the last
// one from the outer scope. The result was 57,178 leftover directories dated
// across one week of development, which filled the disk and killed a
// verification run mid-flight.
//
// So cleanup is not the caller's job any more. This module registers every
// directory it hands out and removes them from a process exit handler, which
// runs after a normal return, after an uncaught throw, and after an explicit
// process.exit -- the three ways a suite ends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created=[];
const truthy=v=>!!v&&!['0','false','no','off'].includes(String(v).toLowerCase());
const keep=()=>truthy(process.env.AGENT_SDLC_KEEP_TEMP);

/**
 * A registered temporary directory. `prefix` keeps the existing per-suite
 * naming, which is what makes a stray directory attributable to a suite.
 */
export function makeTempDir(prefix){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),prefix));
  created.push(dir);
  return dir;
}

/** Every directory handed out so far, for a suite that wants to assert on them. */
export function registeredTempDirs(){return [...created];}

/**
 * Remove what is left. Idempotent, and tolerant of a directory a suite already
 * removed itself -- an explicit rmSync inside a long suite is still worth
 * having, it just no longer has to be the only cleanup.
 */
export function cleanupTempDirs(){
  if(keep()){
    if(created.length)process.stderr.write(`AGENT_SDLC_KEEP_TEMP: keeping ${created.length} temp fixture(s) under ${os.tmpdir()}\n`);
    return [];
  }
  const removed=[];
  while(created.length){
    const dir=created.pop();
    try{fs.rmSync(dir,{recursive:true,force:true});removed.push(dir);}
    catch{/* a locked directory is not worth failing a suite over */}
  }
  return removed;
}

// `exit` fires for a normal return, for process.exit(code), and after an
// uncaught exception has been reported -- which is the case that leaked most.
// It must stay synchronous: nothing asynchronous runs during exit.
process.on('exit',cleanupTempDirs);
