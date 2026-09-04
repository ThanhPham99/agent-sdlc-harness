import fs from 'node:fs';
import path from 'node:path';
import {gitSha} from './util.mjs';

// Project detection decides which commands the verification gates can run. Two
// things it must never do: crash, and stay silent about what it could not work
// out.
//
//   * The files it reads belong to the user and are hand-edited. A trailing
//     comma in package.json used to escape as a bare SyntaxError, so `init` --
//     and `start`, which auto-initializes -- failed outright on a repository the
//     harness was perfectly able to work in.
//   * Detection stopped at the first matching marker. A repository with a
//     package.json that declares no test script and a go.mod beside it produced
//     no test command at all, while `go test ./...` was right there, leaving
//     every targeted-verification gate with nothing to run.

const readJsonFile=(abs,warnings,label)=>{
  try{return JSON.parse(fs.readFileSync(abs,'utf8'));}
  catch(e){warnings.push(`${label} could not be parsed (${String(e.message).slice(0,120)}); its commands were not detected`);return null;}
};

/**
 * Ordered by how strongly the marker identifies the project. Each detector
 * returns the commands it is confident about; `{}` means "recognized the stack,
 * found nothing runnable", which lets a later detector supply the commands.
 */
const DETECTORS=[
  {stack:'node',markers:['package.json'],commands(root,warnings){
    const pkg=readJsonFile(path.join(root,'package.json'),warnings,'package.json');
    if(!pkg)return {};
    const c={};
    if(pkg.scripts?.test){c.test_full=['npm','test'];c.test_targeted=['npm','test','--','{selector}'];}
    if(pkg.scripts?.build)c.build=['npm','run','build'];
    return c;
  }},
  {stack:'python',markers:['pyproject.toml','pytest.ini','setup.py','requirements.txt','tox.ini'],commands(){
    return {test_full:['python','-m','pytest'],test_targeted:['python','-m','pytest','{selector}']};
  }},
  {stack:'go',markers:['go.mod'],commands(){
    return {test_full:['go','test','./...'],test_targeted:['go','test','{selector}'],build:['go','build','./...']};
  }},
  {stack:'rust',markers:['Cargo.toml'],commands(){
    return {test_full:['cargo','test'],test_targeted:['cargo','test','{selector}'],build:['cargo','build']};
  }},
  {stack:'gradle',markers:['build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts'],commands(root){
    // A wrapper pins the build's own Gradle version and is what CI runs.
    const wrapper=fs.existsSync(path.join(root,'gradlew'))?['./gradlew']:['gradle'];
    return {test_full:[...wrapper,'test'],test_targeted:[...wrapper,'test','--tests','{selector}'],build:[...wrapper,'build']};
  }},
  {stack:'maven',markers:['pom.xml'],commands(){
    return {test_full:['mvn','-q','test'],test_targeted:['mvn','-q','-Dtest={selector}','test'],build:['mvn','-q','-DskipTests','package']};
  }},
  {stack:'dotnet',markers:['*.sln','*.csproj','*.fsproj'],commands(){
    return {test_full:['dotnet','test'],test_targeted:['dotnet','test','--filter','{selector}'],build:['dotnet','build']};
  }}
];

/** Markers may be a literal name or a `*.ext` pattern at the repository root. */
function markerPresent(root,marker){
  if(!marker.startsWith('*.'))return fs.existsSync(path.join(root,marker));
  const ext=marker.slice(1);
  try{return fs.readdirSync(root).some(f=>f.endsWith(ext));}
  catch{return false;}
}

export function detectProject(projectRoot){
  const warnings=[];
  const detected=DETECTORS.filter(d=>d.markers.some(m=>markerPresent(projectRoot,m)));
  let stack='unknown',commands={};
  // The first detected stack names the project. Commands are filled in per key,
  // first stack to offer one wins, so a repository whose primary stack declares
  // a build but no tests keeps that build and still gets a test command from the
  // stack beside it.
  for(const d of detected){
    const c=d.commands(projectRoot,warnings)||{};
    if(stack==='unknown')stack=d.stack;
    for(const [key,value] of Object.entries(c)){
      if(commands[key])continue;
      commands[key]=value;
      if(d.stack!==stack&&key==='test_targeted')warnings.push(`test commands come from the ${d.stack} stack; ${stack} declared none`);
    }
  }
  if(detected.length&&!commands.test_targeted){
    warnings.push(`no test command could be derived from ${detected.map(d=>d.stack).join(', ')}; set commands.test_targeted in .agent-sdlc/project.json before relying on targeted verification`);
  }
  if(!detected.length)warnings.push('no known project marker at the repository root; set commands in .agent-sdlc/project.json');
  return {
    schema:'agent-sdlc/project/v1',
    project:path.basename(projectRoot),
    created_from_git_sha:gitSha(projectRoot),
    stack,
    stacks:detected.map(d=>d.stack),
    detection_warnings:warnings,
    risk_profile:'STANDARD',
    default_provider:'auto',
    commands,
    context:{project_invariants:[],hot_paths:[]},
    approval:{mode:'risk-based'},
    source_of_truth_mode:'repo_authoritative',
    providers:{preferred:['claude','codex','antigravity']}
  };
}
