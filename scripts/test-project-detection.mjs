#!/usr/bin/env node
// Project detection and config layering.
//
// detectProject decides which commands the verification gates can run, and
// resolveConfig decides what the harness believes about a project. Both read
// hand-edited user files, and both were at roughly half coverage. Their failure
// modes are the interesting part: a repository the harness cannot initialize, or
// a stage with no test command to run, is not a small problem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {detectProject} from '../runtime/init.mjs';
import {resolveConfig} from '../runtime/config.mjs';
import {createSuite} from './lib/suite.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const CLI=path.join(ROOT,'runtime','cli.mjs');
const {test,assert,finish}=createSuite('agent-sdlc/project-detection-validation/v1','PROJECT-DETECTION-VALIDATION.json');

function repo(files={},{git=true}={}){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'agent-sdlc-detect-'));
  if(git)execFileSync('git',['init','-q'],{cwd:d});
  for(const [rel,body] of Object.entries(files)){
    const abs=path.join(d,rel);
    fs.mkdirSync(path.dirname(abs),{recursive:true});
    fs.writeFileSync(abs,body);
  }
  return d;
}
const cli=(args,cwd)=>{
  const r=spawnSync(process.execPath,[CLI,...args,'--project',cwd],{cwd,encoding:'utf8',timeout:60000});
  return {status:r.status,stdout:r.stdout||'',stderr:r.stderr||''};
};
const pkg=(o)=>JSON.stringify(o);

// --- per-stack detection ---------------------------------------------------
const CASES=[
  ['node',{'package.json':pkg({name:'x',scripts:{test:'jest',build:'tsc'}})},'npm',['test_full','test_targeted','build']],
  ['python',{'pyproject.toml':'[project]\nname="x"\n'},'python',['test_full','test_targeted']],
  ['python',{'requirements.txt':'pytest\n'},'python',['test_full','test_targeted']],
  ['python',{'setup.py':'from setuptools import setup\n'},'python',['test_full','test_targeted']],
  ['go',{'go.mod':'module x\n'},'go',['test_full','test_targeted','build']],
  ['rust',{'Cargo.toml':'[package]\nname="x"\n'},'cargo',['test_full','test_targeted','build']],
  ['maven',{'pom.xml':'<project/>'},'mvn',['test_full','test_targeted','build']],
  ['gradle',{'build.gradle':'plugins {}'},'gradle',['test_full','test_targeted','build']],
  ['dotnet',{'App.csproj':'<Project/>'},'dotnet',['test_full','test_targeted','build']]
];
for(const [stack,files,binary,expected] of CASES){
  test(`detects-${stack}-from-${Object.keys(files)[0]}`,()=>{
    const cfg=detectProject(repo(files));
    assert(cfg.stack===stack,`stack ${cfg.stack}`);
    for(const key of expected)assert(Array.isArray(cfg.commands[key]),`${key} missing: ${JSON.stringify(cfg.commands)}`);
    assert(cfg.commands.test_full[0]===binary,`test runner ${cfg.commands.test_full[0]}`);
    assert(cfg.commands.test_targeted.join(' ').includes('{selector}'),'targeted command has no selector placeholder');
    assert(cfg.detection_warnings.length===0,JSON.stringify(cfg.detection_warnings));
  });
}
test('a-gradle-wrapper-is-preferred-over-a-system-gradle',()=>{
  const withWrapper=detectProject(repo({'build.gradle':'plugins {}','gradlew':'#!/bin/sh\n'}));
  assert(withWrapper.commands.test_full[0]==='./gradlew',JSON.stringify(withWrapper.commands.test_full));
  const without=detectProject(repo({'build.gradle':'plugins {}'}));
  assert(without.commands.test_full[0]==='gradle',JSON.stringify(without.commands.test_full));
});
test('an-unknown-project-says-so-instead-of-inventing-commands',()=>{
  const cfg=detectProject(repo({'README.md':'nothing to see'}));
  assert(cfg.stack==='unknown'&&cfg.stacks.length===0,JSON.stringify({stack:cfg.stack,stacks:cfg.stacks}));
  assert(Object.keys(cfg.commands).length===0,JSON.stringify(cfg.commands));
  assert(cfg.detection_warnings.some(w=>/no known project marker/.test(w)),JSON.stringify(cfg.detection_warnings));
});

// --- hand-edited files -----------------------------------------------------
test('an-unparseable-package-json-does-not-stop-initialization',()=>{
  // Regression: a trailing comma made `init` -- and `start`, which
  // auto-initializes -- fail outright on a repository the harness can work in.
  const d=repo({'package.json':'{\n  "name": "x",\n  "scripts": { "test": "jest" },\n}'});
  const cfg=detectProject(d);
  assert(cfg.stack==='node',cfg.stack);
  assert(cfg.detection_warnings.some(w=>/package\.json could not be parsed/.test(w)),JSON.stringify(cfg.detection_warnings));
  const out=cli(['init'],d);
  assert(out.status===0,`init exited ${out.status}: ${(out.stderr||out.stdout).slice(0,200)}`);
  assert(JSON.parse(out.stdout).status==='INITIALIZED',out.stdout.slice(0,120));
});
test('a-broken-package-json-still-yields-commands-from-a-sibling-stack',()=>{
  const cfg=detectProject(repo({'package.json':'{oops','go.mod':'module x\n'}));
  assert(cfg.commands.test_full?.[0]==='go',JSON.stringify(cfg.commands));
});

// --- polyglot repositories -------------------------------------------------
test('a-stack-with-no-test-script-falls-through-to-one-that-has-tests',()=>{
  // Regression: package.json without a test script won, so the repository ended
  // up with no test command while `go test ./...` sat beside it.
  const cfg=detectProject(repo({'package.json':pkg({name:'web'}),'go.mod':'module x\n'}));
  assert(cfg.stack==='node','the primary stack should still name the project');
  assert(cfg.stacks.includes('node')&&cfg.stacks.includes('go'),JSON.stringify(cfg.stacks));
  assert(cfg.commands.test_targeted?.[0]==='go',JSON.stringify(cfg.commands));
  assert(cfg.detection_warnings.some(w=>/test commands come from the go stack/.test(w)),JSON.stringify(cfg.detection_warnings));
});
test('a-build-only-primary-stack-keeps-its-build-and-borrows-the-tests',()=>{
  // Commands are filled per key: replacing the whole set would drop a valid
  // `npm run build` on the way to finding a test command.
  const cfg=detectProject(repo({'package.json':pkg({name:'web',scripts:{build:'tsc'}}),'go.mod':'module x\n'}));
  assert(cfg.commands.build?.join(' ')==='npm run build',JSON.stringify(cfg.commands.build));
  assert(cfg.commands.test_targeted?.[0]==='go',JSON.stringify(cfg.commands.test_targeted));
  assert(cfg.commands.test_full?.join(' ')==='go test ./...',JSON.stringify(cfg.commands.test_full));
});
test('a-stack-that-declares-tests-keeps-its-own-commands',()=>{
  const cfg=detectProject(repo({'package.json':pkg({name:'web',scripts:{test:'vitest'}}),'go.mod':'module x\n'}));
  assert(cfg.commands.test_full[0]==='npm',JSON.stringify(cfg.commands));
  assert(cfg.detection_warnings.length===0,JSON.stringify(cfg.detection_warnings));
});
test('a-recognized-stack-with-nothing-runnable-warns-about-verification',()=>{
  const cfg=detectProject(repo({'package.json':pkg({name:'web'})}));
  assert(cfg.stack==='node'&&!cfg.commands.test_targeted,JSON.stringify(cfg.commands));
  assert(cfg.detection_warnings.some(w=>/no test command could be derived/.test(w)),JSON.stringify(cfg.detection_warnings));
  assert(cfg.detection_warnings.some(w=>/targeted verification/.test(w)),'the warning does not say what breaks');
});

// --- config layering -------------------------------------------------------
test('config-layers-are-reported-in-precedence-order',()=>{
  const d=repo({});
  cli(['init'],d);
  const c=resolveConfig(d);
  assert(c.precedence[0]==='built-in policy'&&c.precedence.at(-1)==='cli',JSON.stringify(c.precedence));
  assert(c.layers.some(l=>l.name==='project'),JSON.stringify(c.layers));
  assert(c.effective.risk_profile==='STANDARD',JSON.stringify(c.effective.risk_profile));
});
test('cli-overrides-win-over-the-project-layer',()=>{
  const d=repo({});
  cli(['init'],d);
  const c=resolveConfig(d,{risk_profile:'STRICT'});
  assert(c.effective.risk_profile==='STRICT',JSON.stringify(c.effective.risk_profile));
  assert(c.layers.at(-1).name==='cli',JSON.stringify(c.layers.at(-1)));
});
test('an-unreadable-config-layer-is-skipped-and-named',()=>{
  // Regression: this threw a bare SyntaxError out of config-show and doctor --
  // the commands you run to find out what is wrong with your setup.
  const d=repo({});
  fs.mkdirSync(path.join(d,'.agent-sdlc'),{recursive:true});
  fs.writeFileSync(path.join(d,'.agent-sdlc','project.json'),'{"risk_profile":');
  const c=resolveConfig(d);
  const broken=c.layers.find(l=>l.name==='project');
  assert(broken?.status==='UNREADABLE'&&broken.applied===false,JSON.stringify(broken));
  assert(c.problems?.some(p=>p.includes('project.json')),JSON.stringify(c.problems));
  for(const cmd of [['config-show'],['doctor']]){
    const out=cli(cmd,d);
    assert(out.status===0,`${cmd[0]} exited ${out.status}: ${(out.stderr||'').slice(0,160)}`);
  }
});
test('environment-variables-form-their-own-layer',()=>{
  const d=repo({});
  cli(['init'],d);
  const previous=process.env.AGENT_SDLC_PROFILE;
  process.env.AGENT_SDLC_PROFILE='STRICT';
  try{
    const c=resolveConfig(d);
    assert(c.effective.risk_profile==='STRICT',JSON.stringify(c.effective.risk_profile));
    assert(c.layers.some(l=>l.name==='environment'),JSON.stringify(c.layers));
  }finally{
    if(previous===undefined)delete process.env.AGENT_SDLC_PROFILE;else process.env.AGENT_SDLC_PROFILE=previous;
  }
});

// --- the detected config is what the harness runs with ---------------------
test('the-detected-commands-reach-the-persisted-project-config',()=>{
  const d=repo({'go.mod':'module x\n'});
  const out=cli(['init'],d);
  assert(out.status===0,out.stderr.slice(0,160));
  const persisted=JSON.parse(fs.readFileSync(path.join(d,'.agent-sdlc','project.json'),'utf8'));
  assert(persisted.commands.test_full.join(' ')==='go test ./...',JSON.stringify(persisted.commands));
  assert(persisted.stacks.includes('go'),JSON.stringify(persisted.stacks));
});

finish();
