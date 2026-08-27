// The shared shape of an offline suite.
//
// Seven suites each declared their own `let pass=0,fail=0`, their own `test()`,
// their own `assert()`, and their own report-write-print-exit tail. They had
// drifted apart in ways that only show up when something fails: most truncated
// an error message to 400 characters and one did not, so a suite that threw a
// large diff wrote it whole into a tracked report; two supported skipped cases
// and five had no way to express one.
//
// This is not a test framework. It is the four lines every suite already had,
// written once, so the report contract -- what a row looks like, how a failure
// exits, what lands in evals/ -- is defined in a single place.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..');

// A failure message goes into a tracked report, so it is bounded. Long enough
// for a JSON fragment plus context; short enough that one bad case cannot turn
// the report into a diff nobody can read.
const ERROR_LIMIT=400;

/**
 * @param {string} schema  the report's schema id
 * @param {string} file    report filename under evals/, or null to print only
 */
export function createSuite(schema,file){
  let pass=0,fail=0,skip=0;
  const rows=[];

  const settle=(name,v)=>{
    if(v==='SKIP'){skip++;rows.push({name,status:'SKIP'});return;}
    pass++;rows.push({name,status:'PASS'});
  };
  const failed=(name,e)=>{
    fail++;rows.push({name,status:'FAIL',error:String(e.message).slice(0,ERROR_LIMIT)});
  };

  /**
   * A case. Return the string 'SKIP' to record it as skipped rather than run.
   *
   * Sync and async bodies both work: a sync case records its row before this
   * returns, so existing callers need no await, and an async one is awaited by
   * the promise this hands back. The MCP suite drives a live stdio server and
   * needs the async form; it previously kept a second results array and copied
   * it into the report at the end.
   */
  const test=(name,fn)=>{
    try{
      const v=fn();
      if(v&&typeof v.then==='function')return v.then(r=>settle(name,r),e=>failed(name,e));
      settle(name,v);
    }catch(e){failed(name,e);}
    return Promise.resolve();
  };

  const assert=(cond,msg)=>{if(!cond)throw new Error(msg);};

  /**
   * Write the report, print it, and exit with the suite's verdict.
   * `fields` are merged in after the schema, where each suite's own context
   * (harness version, platform, which optional tools were present) belongs.
   * A passing run prints `results:'all-pass'` instead of every row; the file on
   * disk always keeps the rows.
   */
  const finish=(fields={})=>{
    const report={schema,...fields,checks:rows.length,passes:pass,failures:fail,skipped:skip,results:rows};
    if(file)fs.writeFileSync(path.join(ROOT,'evals',file),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(fail?report:{...report,results:'all-pass'},null,2));
    process.exit(fail?1:0);
  };

  return {test,assert,finish,rows,counts:()=>({pass,fail,skip})};
}
