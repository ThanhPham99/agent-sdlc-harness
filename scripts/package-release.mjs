#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=fs.readFileSync(path.join(ROOT,'VERSION'),'utf8').trim();
const release=path.join(ROOT,'release');
fs.rmSync(release,{recursive:true,force:true});fs.mkdirSync(release,{recursive:true});
const dist=path.join(ROOT,'dist');
for(const host of ['claude','codex','antigravity']){
  const src=path.join(dist,`agent-sdlc-${host}-${version}.zip`);
  if(!fs.existsSync(src))throw new Error(`missing built artifact ${src}; run npm run build first`);
  fs.copyFileSync(src,path.join(release,path.basename(src)));
}
const sourceZip=path.join(release,`agent-sdlc-harness-source-${version}.zip`);
const base=path.basename(ROOT);const parent=path.dirname(ROOT);
execFileSync('zip',['-qr',sourceZip,base,'-x',`${base}/.git/*`,`${base}/dist/*`,`${base}/release/*`,`${base}/node_modules/*`,`${base}/evals/qualification/*`],{cwd:parent});
const files=fs.readdirSync(release).filter(x=>x.endsWith('.zip')).sort();
const lines=[];
for(const f of files){const b=fs.readFileSync(path.join(release,f));lines.push(`${crypto.createHash('sha256').update(b).digest('hex')}  ${f}`);}
fs.writeFileSync(path.join(release,'SHA256SUMS.txt'),lines.join('\n')+'\n');
console.log(JSON.stringify({schema:'agent-sdlc/release-package/v1',version,release,files:[...files,'SHA256SUMS.txt']},null,2));
