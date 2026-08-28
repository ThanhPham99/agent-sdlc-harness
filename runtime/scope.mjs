// Write/interface scope overlap: one predicate, one policy model.
//
// Three places decide whether two task scopes collide, and they have to agree:
//   runtime/plan-validator.mjs  refuses a PLAN whose parallel candidates collide
//   runtime/task-scheduler.mjs  refuses to dispatch colliding tasks together
//   runtime/parallel.mjs        the same call for an ad-hoc task list
//
// The scheduler's header already said this was one model rather than two, and
// scripts/validate-task-engine.mjs asserts it -- but the PLAN gate carried its
// own copy of the function, outside that claim. Identical today is not the
// point: the two answer the same question at different moments, so a fix
// applied to one and not the other would accept a plan the scheduler then
// refuses to run, or the reverse. The predicate lives here so there is nothing
// to keep in step.
//
// This module stays dependency-free on purpose. plan-validator.mjs promises no
// repository reads, no network and no model inference, and task-scheduler.mjs
// imports task-engine.mjs, which imports plan-validator.mjs -- importing the
// scheduler from the validator would close that cycle.

const arr=x=>Array.isArray(x)?x:[];

/** Separators folded, a leading `./` and any trailing `/` dropped. */
export const normScope=p=>String(p||'').replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/+$/,'');

/**
 * Two scope entries overlap when either is a path prefix of the other.
 *
 * Prefix-aware at directory boundaries, not by raw string prefix: `src/auth/`
 * collides with `src/auth/reset.js`, while `src/auth` and `src/authentication`
 * do not. A glob is reduced to the literal text before its first wildcard, so
 * `src/*` collides with `src/auth/a.js`; a pattern with no literal stem claims
 * everything and collides with anything.
 */
export function scopeOverlap(a,b){
  const x=normScope(a),y=normScope(b);
  if(!x||!y)return false;
  if(x===y)return true;
  const stem=s=>s.split(/[*?]/)[0].replace(/\/+$/,'');
  const sx=stem(x),sy=stem(y);
  if(!sx||!sy)return true; // a bare "*" claims everything
  return sx===sy||sx.startsWith(sy+'/')||sy.startsWith(sx+'/');
}

/** Every overlapping pair between two scope lists. */
export function scopeConflicts(a,b){
  const out=[];
  for(const x of arr(a))for(const y of arr(b))if(scopeOverlap(x,y))out.push([x,y]);
  return out;
}
