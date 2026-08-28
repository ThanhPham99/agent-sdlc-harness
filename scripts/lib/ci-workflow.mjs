// Pure text parsing of a GitHub Actions workflow file, shared by
// scripts/validate-ci-coverage.mjs and its test. Kept separate from that
// script (which is a standalone CLI that validates and exits on import) so a
// test can import these functions without also running the whole validator.
//
// This is intentionally not a real YAML parser: the workflow files here have
// a fixed, simple shape (two-space job indent, `run:` step bodies), and a
// dependency-free regex read of that shape is enough.

/**
 * A job's own step lines, top-level-indent-delimited from the next job.
 * Takes the workflow text as a parameter so a unit test can hand it a small
 * synthetic workflow instead of needing a throwaway file on disk.
 */
export function jobBlock(workflowText,jobName){
  const lines=workflowText.split('\n');
  const start=lines.findIndex(l=>new RegExp(`^  ${jobName}:\\s*$`).test(l));
  if(start<0)throw new Error(`workflow has no top-level job named \`${jobName}\``);
  let end=lines.length;
  for(let i=start+1;i<lines.length;i++){
    if(/^  [a-zA-Z][a-zA-Z0-9_-]*:\s*$/.test(lines[i])){end=i;break;}
  }
  return lines.slice(start,end);
}

/** The scripts a job's `run:` steps invoke, in the order they appear. */
export function jobScriptSequence(workflowText,jobName){
  const invocation=/^\s*run:\s*npm (?:run )?([a-z0-9:-]+)/;
  return jobBlock(workflowText,jobName).map(l=>l.match(invocation)).filter(Boolean).map(m=>m[1]);
}
