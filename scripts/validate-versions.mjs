#!/usr/bin/env node
// Version consistency across every surface that states a version.
//
// VERSION is the single source of truth. Three classes of statement, with
// different rules, because they mean different things:
//
//   EXACT     Distribution manifests, marketplace entries, public skill
//             metadata and doc titles. These tell a host or a reader "this is
//             release X". A stale one is a false statement, and for the
//             manifests it is what a host installs by.
//   NOT_AHEAD Internal registry and policy stamps. These record the release
//             whose content they carry, so lagging is legitimate; claiming a
//             release that does not exist yet is not. Laggards are reported as
//             `behind` so the drift stays visible without forcing churn.
//   HISTORY   docs/releases/* and "(vX)" feature labels. Never rewritten:
//             they describe when something happened.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8');
const rj=p=>JSON.parse(read(p));
const VERSION=read('VERSION').trim();

// 3.0.0-alpha6 -> comparable tuple. Prerelease identifiers compare
// numerically on their trailing digits, so alpha6 > alpha3 rather than
// sorting as strings where "alpha10" < "alpha3".
function parse(v){
  const m=/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v||'').trim());
  if(!m)return null;
  const pre=m[4]?m[4].split('.').map(part=>{
    const d=/^([A-Za-z-]*)(\d*)$/.exec(part);
    return d?[d[1],d[2]===''?-1:Number(d[2])]:[part,-1];
  }):null;
  return {core:[Number(m[1]),Number(m[2]),Number(m[3])],pre};
}
function compare(a,b){
  const x=parse(a),y=parse(b);
  if(!x||!y)return NaN;
  for(let i=0;i<3;i++)if(x.core[i]!==y.core[i])return x.core[i]-y.core[i];
  if(!x.pre&&!y.pre)return 0;
  if(!x.pre)return 1;            // release > prerelease
  if(!y.pre)return -1;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++){
    const a1=x.pre[i],b1=y.pre[i];
    if(!a1)return -1;
    if(!b1)return 1;
    if(a1[0]!==b1[0])return a1[0]<b1[0]?-1:1;
    if(a1[1]!==b1[1])return a1[1]-b1[1];
  }
  return 0;
}

const problems=[];
const behind=[];
const checks=[];

function exact(where,found){
  const ok=found===VERSION;
  checks.push({class:'EXACT',where,found,status:ok?'PASS':'FAIL'});
  if(!ok)problems.push({where,found,expected:VERSION,detail:'must state the current release exactly'});
}
function notAhead(where,found){
  const c=compare(found,VERSION);
  if(Number.isNaN(c)){
    checks.push({class:'NOT_AHEAD',where,found,status:'FAIL'});
    problems.push({where,found,expected:`<= ${VERSION}`,detail:'not a parseable version'});
    return;
  }
  const ok=c<=0;
  checks.push({class:'NOT_AHEAD',where,found,status:ok?'PASS':'FAIL'});
  if(!ok)problems.push({where,found,expected:`<= ${VERSION}`,detail:'claims a release that does not exist yet'});
  else if(c<0)behind.push({where,found,current:VERSION});
}

// --- EXACT: what a host installs by, and what a reader is told -------------
exact('package.json#version',rj('package.json').version);
exact('agent-sdlc.manifest.json#version',rj('agent-sdlc.manifest.json').version);
exact('.claude-plugin/plugin.json#version',rj('.claude-plugin/plugin.json').version);
exact('.codex-plugin/plugin.json#version',rj('.codex-plugin/plugin.json').version);
exact('adapters/claude/plugin.json#version',rj('adapters/claude/plugin.json').version);
exact('adapters/codex/plugin.json#version',rj('adapters/codex/plugin.json').version);
for(const [i,p] of (rj('.claude-plugin/marketplace.json').plugins||[]).entries())
  exact(`.claude-plugin/marketplace.json#plugins[${i}].version`,p.version);

// Public skill metadata is rendered into the host's skill list.
for(const pub of rj('config/skills.json').public||[]){
  const body=read(`skills/${pub}/SKILL.md`);
  const m=/^\s*version:\s*"?([^"\n]+)"?\s*$/m.exec(body.split('---')[1]||'');
  if(!m)problems.push({where:`skills/${pub}/SKILL.md`,found:null,expected:VERSION,detail:'no metadata.version in frontmatter'});
  else exact(`skills/${pub}/SKILL.md#metadata.version`,m[1].trim());
}

// Doc statements. Feature labels of the form "(v3.0.0-alphaN)" are history and
// are skipped; everything else that names a version is a claim about now.
// Two historical idioms are skipped: a "(vX)" feature label, and a version
// quoted as inline code, which is how these docs name a past release as the
// subject of a sentence ("`3.0.0-alpha4` adds auto-bootstrap").
const HISTORICAL_LABEL=/\(v\d+\.\d+\.\d+[0-9A-Za-z.-]*\)|`v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+`/;
const docFiles=[];
(function walk(dir){
  for(const e of fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true})){
    const rel=`${dir}/${e.name}`;
    if(e.isDirectory()){if(rel!=='docs/releases')walk(rel);}
    else if(e.name.endsWith('.md'))docFiles.push(rel);
  }
})('docs');
docFiles.push('README.md');
const VERSION_LITERAL=/\b\d+\.\d+\.\d+-[0-9A-Za-z.-]+\b/g;
for(const rel of docFiles){
  read(rel).split('\n').forEach((line,i)=>{
    if(HISTORICAL_LABEL.test(line))return;
    for(const found of line.match(VERSION_LITERAL)||[])
      // A version inside a filename carries an extension; compare the version.
      exact(`${rel}:${i+1}`,found.replace(/\.(?:zip|tar|gz|md|json|txt)$/,''));
  });
}

// --- NOT_AHEAD: internal registry and policy stamps ------------------------
for(const dir of ['config','policies']){
  for(const f of fs.readdirSync(path.join(ROOT,dir))){
    if(!f.endsWith('.json')||f.includes('.example.'))continue;
    const j=rj(`${dir}/${f}`);
    if(j.version)notAhead(`${dir}/${f}#version`,j.version);
  }
}
for(const f of fs.readdirSync(path.join(ROOT,'evals'))){
  if(!f.endsWith('.json'))continue;
  const j=rj(`evals/${f}`);
  if(j.version)notAhead(`evals/${f}#version`,j.version);
}

const report={
  schema:'agent-sdlc/version-consistency/v1',
  version:VERSION,
  checks:checks.length,
  passes:checks.filter(c=>c.status==='PASS').length,
  failures:problems.length,
  // Legitimate laggards, surfaced rather than silently tolerated.
  behind,
  problems,
  status:problems.length?'FAIL':'PASS'
};
fs.writeFileSync(path.join(ROOT,'evals','VERSION-CONSISTENCY.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exit(problems.length?1:0);
