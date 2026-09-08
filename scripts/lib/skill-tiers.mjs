// The single reader of the plugin's skill surface.
//
// Six scripts each re-derived "which skills are discoverable" from
// manifest.public_skills or a hardcoded two-element fallback, so adding a tier
// meant finding all six. The surface is declared once, in the manifest, and
// read here.
import fs from 'node:fs';
import path from 'node:path';

const arr=x=>Array.isArray(x)?x:[];

/**
 * @param {string} root  harness root
 * @returns {{entry:string[],ops:string[],stage:string[],procedure:string[],discovery:string[],all:string[]}}
 */
export function readSkillTiers(root){
  const manifestPath=path.join(root,'agent-sdlc.manifest.json');
  const manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{};
  const entry=arr(manifest.entry_skills);
  const ops=arr(manifest.ops_skills);
  const stage=arr(manifest.stage_skills);
  const procedure=arr(manifest.procedure_skills);
  const discovery=[...entry,...ops,...stage].sort();
  return {entry,ops,stage,procedure,discovery,all:[...discovery,...procedure]};
}

/**
 * Filesystem location of a tier member's SKILL.md, relative to the harness
 * root. Procedure skills live under skills/procedures/ so they never sit in the
 * host's discovery root beside the entry skills.
 */
export function skillBodyPath(tiers,id){
  return tiers.procedure.includes(id)
    ? path.join('skills','procedures',id,'SKILL.md')
    : path.join('skills',id,'SKILL.md');
}
