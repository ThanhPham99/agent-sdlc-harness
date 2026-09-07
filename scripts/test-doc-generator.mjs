import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeTempDir} from './lib/tempdir.mjs';
import {initProject} from '../runtime/store.mjs';
import * as layout from '../runtime/layout.mjs';
import {ensureStandardDocs,generateRunReport,updateSummaryIndex} from '../runtime/doc-generator.mjs';
import {commands as runCommands} from '../runtime/commands/run.mjs';

function makeTempProject(){
  const dir=makeTempDir('test-sdlc-doc-');
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'test-proj',scripts:{test:'echo pass'}}));
  return dir;
}

test('initProject creates docs and reports directories and initializes template files',async()=>{
  const dir=makeTempProject();
  try{
    initProject(dir,{project:'test-proj'});
    // Asserted through the layout, so the destinations cannot drift from the
    // tree the runtime actually writes -- this test asserted the v1 paths and
    // went red unnoticed, because `test:doc-generator` was gated by neither
    // test:integrity nor CI.
    assert.equal(fs.existsSync(layout.docsDir(dir)),true);
    assert.equal(fs.existsSync(layout.guidesDir(dir)),true);
    assert.equal(fs.existsSync(layout.reportsDir(dir)),true);
    assert.equal(fs.existsSync(layout.summaryFile(dir)),true);
    assert.equal(fs.existsSync(layout.reviewFile(dir)),true);
    for(const guide of ['README.md','ARCHITECTURE-AND-STATE.md','WORKFLOWS-GUIDE.md','CLI-CHEAT-SHEET.md'])
      assert.equal(fs.existsSync(layout.guideFile(dir,guide)),true,`missing guide ${guide}`);
    // And the tree carries its version stamp.
    assert.equal(JSON.parse(fs.readFileSync(layout.layoutFile(dir),'utf8')).layout_version,layout.LAYOUT_VERSION);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('generateRunReport creates a structured markdown report',async()=>{
  const dir=makeTempProject();
  try{
    initProject(dir,{project:'test-proj'});
    const mockRun={
      run_id:'test-run-12345',
      objective:'Add human readable report feature',
      workflow:'new-feature',
      profile:'STANDARD',
      state:'CLOSE',
      created_at:new Date().toISOString(),
      updated_at:new Date().toISOString(),
      revision:5,
      evidence:{
        REQUIREMENTS:['requirements_confirmed'],
        VERIFY:['targeted_verification_pass']
      },
      artifacts:['art_hash_123']
    };
    const res=generateRunReport(dir,mockRun);
    assert.equal(res.status,'GENERATED');
    assert.equal(fs.existsSync(res.report_file),true);
    const content=fs.readFileSync(res.report_file,'utf8');
    assert.match(content,/# Báo Cáo Thực Thi SDLC: Run test-run-12345/);
    assert.match(content,/Add human readable report feature/);
    assert.match(content,/targeted_verification_pass/);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('updateSummaryIndex generates master index with reports and recent runs',async()=>{
  const dir=makeTempProject();
  try{
    initProject(dir,{project:'test-proj'});
    const summaryFile=updateSummaryIndex(dir);
    assert.equal(fs.existsSync(summaryFile),true);
    const content=fs.readFileSync(summaryFile,'utf8');
    assert.match(content,/# Bảng Tóm Tắt Trạng Thái & Trung Tâm Tài Liệu SDLC/);
    assert.match(content,/ARCHITECTURE-AND-STATE.md/);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('CLI report command successfully generates summary and reports',async()=>{
  const dir=makeTempProject();
  try{
    initProject(dir,{project:'test-proj'});
    let printed=null;
    const ctx={
      projectRoot:dir,
      print:x=>{printed=x;},
      needRun:async()=>null,
      args:{}
    };
    await runCommands.report(ctx);
    assert.equal(printed?.status,'REPORT_GENERATED');
    assert.equal(fs.existsSync(printed.summary_file),true);
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
