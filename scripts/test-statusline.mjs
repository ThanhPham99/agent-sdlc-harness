#!/usr/bin/env node
// Smoke-tests the opt-in statusLine script against the shapes a status
// payload can plausibly take, since its exact schema is not part of the
// stable Claude Code contract: missing fields must degrade gracefully
// instead of throwing, and it must stay fast enough for a per-render command.
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rows=[];let fail=0;
const test=(name,fn)=>{try{fn();rows.push({name,status:'PASS'});}catch(e){fail++;rows.push({name,status:'FAIL',error:e.message});}};
const assert=(v,m)=>{if(!v)throw new Error(m);};

function run(hookPath,input){
  return spawnSync(process.execPath,[hookPath],{input,encoding:'utf8',timeout:10000,cwd:ROOT});
}

const HOOKS=['adapters/hooks/statusline.mjs','hooks/statusline.mjs'].map(p=>path.join(ROOT,p));

for(const hook of HOOKS){
  const label=path.relative(ROOT,hook).split(path.sep).join('/');

  test(`${label}:full-payload-renders-all-fields`,()=>{
    const r=run(hook,JSON.stringify({
      model:{display_name:'Sonnet 5'},
      context:{used_percentage:42},
      cost:{total_cost_usd:0.83},
      workspace:{current_dir:ROOT}
    }));
    assert(r.status===0,`exit ${r.status}: ${r.stderr}`);
    const out=r.stdout.trim();
    assert(out.includes('Sonnet 5'),`missing model: ${out}`);
    assert(out.includes('ctx 42%'),`missing context: ${out}`);
    assert(out.includes('cost $0.83'),`missing cost: ${out}`);
    assert(/branch \S+/.test(out),`missing branch: ${out}`);
    assert(!r.stderr,`hook wrote diagnostics: ${r.stderr}`);
  });

  test(`${label}:empty-payload-does-not-throw`,()=>{
    const r=run(hook,'{}');
    assert(r.status===0,`exit ${r.status}: ${r.stderr}`);
    assert(r.stdout.trim().length>0,'empty payload produced no output line');
  });

  test(`${label}:malformed-stdin-is-safe`,()=>{
    const r=run(hook,'not json');
    assert(r.status===0,`exit ${r.status}: ${r.stderr}`);
  });

  test(`${label}:missing-cost-omits-cost-not-crash`,()=>{
    const r=run(hook,JSON.stringify({model:{display_name:'Haiku'}}));
    assert(r.status===0,`exit ${r.status}: ${r.stderr}`);
    assert(!r.stdout.includes('cost $NaN'),'cost rendered as NaN instead of being omitted');
  });

  test(`${label}:fast-enough-for-per-render-use`,()=>{
    const start=Date.now();
    run(hook,'{}');
    const ms=Date.now()-start;
    assert(ms<2000,`hook took ${ms}ms, too slow to run on every prompt render`);
  });
}

const report={schema:'agent-sdlc/statusline-test/v1',checks:rows.length,passes:rows.length-fail,failures:fail,status:fail?'FAIL':'PASS',results:rows};
console.log(JSON.stringify(report,null,2));
process.exit(fail?1:0);
