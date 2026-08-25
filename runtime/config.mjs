import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function merge(a,b){if(Array.isArray(b)||b===null||typeof b!=='object')return b;const out={...(a&&typeof a==='object'&&!Array.isArray(a)?a:{})};for(const [k,v] of Object.entries(b))out[k]=merge(out[k],v);return out;}

// Config layers are hand-edited files. An unreadable one used to throw a bare
// SyntaxError out of resolveConfig, which took down `config-show`, `doctor` and
// every activation check -- the commands you run to find out what is wrong with
// your setup. A broken layer is now reported and skipped: the layers below it
// still apply, and the caller can see which file to fix.
function layer(name,p,layers,effective){
  if(!fs.existsSync(p))return effective;
  try{
    const v=JSON.parse(fs.readFileSync(p,'utf8'));
    layers.push({name,path:p});
    return merge(effective,v);
  }catch(e){
    layers.push({name,path:p,status:'UNREADABLE',error:String(e.message).slice(0,200),applied:false});
    return effective;
  }
}

export function resolveConfig(projectRoot,overrides={}){
  const layers=[];let effective={};
  effective=layer('global',path.join(os.homedir(),'.agent-sdlc','config.json'),layers,effective);
  effective=layer('project',path.join(projectRoot,'.agent-sdlc','project.json'),layers,effective);
  const env={};if(process.env.AGENT_SDLC_PROVIDER)env.default_provider=process.env.AGENT_SDLC_PROVIDER;if(process.env.AGENT_SDLC_PROFILE)env.risk_profile=process.env.AGENT_SDLC_PROFILE;
  if(Object.keys(env).length){layers.push({name:'environment',keys:Object.keys(env)});effective=merge(effective,env);}
  if(Object.keys(overrides).length){layers.push({name:'cli',keys:Object.keys(overrides)});effective=merge(effective,overrides);}
  const unreadable=layers.filter(l=>l.status==='UNREADABLE');
  return {schema:'agent-sdlc/effective-config/v1',precedence:['built-in policy','global','project','environment','cli'],layers,
    ...(unreadable.length?{problems:unreadable.map(l=>`${l.name} config at ${l.path} is unreadable and was skipped: ${l.error}`)}:{}),
    effective};
}
