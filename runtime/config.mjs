import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {readJson} from './util.mjs';

function merge(a,b){if(Array.isArray(b)||b===null||typeof b!=='object')return b;const out={...(a&&typeof a==='object'&&!Array.isArray(a)?a:{})};for(const [k,v] of Object.entries(b))out[k]=merge(out[k],v);return out;}
export function resolveConfig(projectRoot,overrides={}){
  const layers=[];let effective={};
  const globalPath=path.join(os.homedir(),'.agent-sdlc','config.json');
  if(fs.existsSync(globalPath)){const v=readJson(globalPath);layers.push({name:'global',path:globalPath});effective=merge(effective,v);}
  const projectPath=path.join(projectRoot,'.agent-sdlc','project.json');
  if(fs.existsSync(projectPath)){const v=readJson(projectPath);layers.push({name:'project',path:projectPath});effective=merge(effective,v);}
  const env={};if(process.env.AGENT_SDLC_PROVIDER)env.default_provider=process.env.AGENT_SDLC_PROVIDER;if(process.env.AGENT_SDLC_PROFILE)env.risk_profile=process.env.AGENT_SDLC_PROFILE;
  if(Object.keys(env).length){layers.push({name:'environment',keys:Object.keys(env)});effective=merge(effective,env);}
  if(Object.keys(overrides).length){layers.push({name:'cli',keys:Object.keys(overrides)});effective=merge(effective,overrides);}
  return {schema:'agent-sdlc/effective-config/v1',precedence:['built-in policy','global','project','environment','cli'],layers,effective};
}
