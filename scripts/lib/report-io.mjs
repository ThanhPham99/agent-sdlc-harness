// Durable write for a tracked evals/*.json report.
//
// Every suite rewrote its report with a plain writeFileSync, which is not
// atomic: for the width of the write the file on disk is truncated. Nothing
// noticed while `npm run check` was an `&&` chain, because nothing else was
// running. It does now -- the suites in a stage run concurrently, and
// validate-versions.mjs reads EVERY evals/*.json to check the version stamps.
// One run of the parallel gate reported 59 checks where an isolated run
// reported 60: a read had landed inside a peer's write, and the truncated
// document simply had no `version` key to count. An undercount is the mild
// outcome; the same race can make a report unparseable and fail a green suite.
//
// Temp file plus rename, the way runtime/util.mjs already writes every JSON
// document the runtime owns. A reader sees the old report or the new one.
// This also means an interrupted run can no longer leave a truncated report
// committed to the tree, which was always possible and never desirable.
import fs from 'node:fs';
import path from 'node:path';

let seq=0;
export function writeReport(file,report){
  const tmp=`${file}.${process.pid}.${seq++}.tmp`;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{
    fs.writeFileSync(tmp,JSON.stringify(report,null,2)+'\n');
    fs.renameSync(tmp,file);
  }catch(e){
    try{fs.rmSync(tmp,{force:true});}catch{}
    throw e;
  }
}
