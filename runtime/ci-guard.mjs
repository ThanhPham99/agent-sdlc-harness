// CI Guard: Automated CI/CD validation before commit & delivery push.
// Enforces the invariant: "If the project has CI/CD, all CI checks must pass 100% before commit or push to remote."
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {gitSha,readJson,truthy} from './util.mjs';
import {recordCiEvidence,ciEvidenceCurrent,loadCiEvidence} from './ci-evidence.mjs';
import {resolveLaunch,describeSpawn} from './launcher.mjs';
import {detectProject} from './init.mjs';

/**
 * Detect CI/CD configurations in the target project.
 * Checks for GitHub Actions workflows, package.json scripts, Makefile, or auto-detects stack.
 */
export function detectProjectCi(projectRoot){
  const ghWorkflowsDir=path.join(projectRoot,'.github','workflows');
  let has_gh_workflows=false;
  try{
    has_gh_workflows=fs.existsSync(ghWorkflowsDir)&&fs.readdirSync(ghWorkflowsDir).some(f=>/\.(ya?ml)$/i.test(f));
  }catch{}

  let package_json_scripts=[];
  const pkgPath=path.join(projectRoot,'package.json');
  if(fs.existsSync(pkgPath)){
    try{
      const pkg=readJson(pkgPath);
      package_json_scripts=Object.keys(pkg.scripts||{});
    }catch{/* ignore */}
  }

  const projectCfgPath=path.join(projectRoot,'.agent-sdlc','project.json');
  let test_commands=null;
  if(fs.existsSync(projectCfgPath)){
    try{
      const cfg=readJson(projectCfgPath);
      test_commands=cfg.test_commands||cfg.commands||null;
    }catch{/* ignore */}
  }

  let detectedProject=null;
  if(!test_commands&&projectRoot&&fs.existsSync(projectRoot)){
    try{
      detectedProject=detectProject(projectRoot);
      if(detectedProject?.commands&&Object.keys(detectedProject.commands).length){
        test_commands=detectedProject.commands;
      }
    }catch{/* ignore */}
  }

  const has_ci=has_gh_workflows||package_json_scripts.includes('check')||package_json_scripts.includes('test')||package_json_scripts.includes('ci')||Boolean(test_commands?.test_full||test_commands?.test_targeted);

  // Determine the best local CI command
  let recommended_command=null;
  if(test_commands?.test_full){
    recommended_command=test_commands.test_full;
  }else if(package_json_scripts.includes('check')){
    recommended_command=['npm','run','check'];
  }else if(package_json_scripts.includes('test')){
    recommended_command=['npm','test'];
  }else if(test_commands?.test_targeted){
    recommended_command=test_commands.test_targeted.filter(arg=>arg!=='{selector}'&&arg!=='--');
  }

  return {
    has_ci,
    has_github_workflows:has_gh_workflows,
    available_scripts:package_json_scripts,
    recommended_command,
    stack:detectedProject?.stack||null
  };
}

/**
 * Execute local CI verification suite and record evidence bound to the current git revision.
 */
export function runLocalCiValidation(root,projectRoot,run,{commandOverride=null,timeoutMs=180000}={}){
  const detection=detectProjectCi(projectRoot);
  const command=commandOverride||detection.recommended_command||['npm','test'];
  const start_time=Date.now();
  const current_rev=gitSha(projectRoot);

  const launch=resolveLaunch(command,{env:process.env,platform:process.platform});
  if(launch.status!=='OK'){
    const failure_record=recordCiEvidence(projectRoot,run,{
      revision:current_rev,
      provider:'local-ci-guard',
      workflow:'pre-commit-ci',
      checks:[{name:command.join(' '),status:'FAIL',duration_ms:0,required:true}],
      logs:`Launch failure: ${launch.reason} (${launch.detail||''})`
    });
    return {
      is_pass:false,
      status:'FAIL',
      reason:launch.reason,
      checks:failure_record.checks,
      duration_ms:0,
      evidence:failure_record
    };
  }

  const spawned=spawnSync(launch.bin,launch.args,{
    cwd:projectRoot,
    encoding:'utf8',
    timeout:timeoutMs,
    shell:launch.via==='cmd',
    windowsVerbatimArguments:launch.spawnOptions?.windowsVerbatimArguments,
    env:process.env
  });

  const duration_ms=Date.now()-start_time;
  const desc=describeSpawn(spawned);
  const is_pass=desc.status==='PASS';
  const stdout=spawned.stdout||'';
  const stderr=spawned.stderr||'';
  const combined_logs=`=== CI RUN COMMAND: ${command.join(' ')} ===\nExit Code: ${spawned.status}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;

  const evidence=recordCiEvidence(projectRoot,run,{
    revision:current_rev,
    provider:'local-ci-guard',
    workflow:'pre-commit-ci',
    checks:[{
      name:command.join(' '),
      status:is_pass?'PASS':'FAIL',
      duration_ms,
      required:true
    }],
    logs:combined_logs
  });

  return {
    is_pass,
    status:is_pass?'PASS':'FAIL',
    exit_code:spawned.status,
    duration_ms,
    checks:evidence.checks,
    evidence
  };
}

/**
 * Ensure current CI evidence is PASS before allowing any commit or push to remote.
 * If stale or missing, automatically triggers local CI verification.
 */
export function ensureCiPassedBeforeDelivery(root,projectRoot,run,{autoRun=true,commandOverride=null}={}){
  const detection=detectProjectCi(projectRoot);
  if(!detection.has_ci){
    // If project has no CI/CD configured, pass through
    return {is_allowed:true,reason:'NO_CI_CONFIGURED',evidence:null};
  }

  const current_rev=gitSha(projectRoot);
  let status=ciEvidenceCurrent(projectRoot,run.run_id,{revision:current_rev});

  if((!status.current||status.status!=='PASS')&&autoRun){
    const result=runLocalCiValidation(root,projectRoot,run,{commandOverride});
    if(!result.is_pass){
      throw new Error(`CI_VALIDATION_FAILED: Local CI check "${result.checks[0]?.name}" failed with exit code ${result.exit_code}. You must fix tests before committing or pushing to remote.`);
    }
    status=ciEvidenceCurrent(projectRoot,run.run_id,{revision:current_rev});
  }

  if(!status.current||status.status!=='PASS'){
    throw new Error(`CI_EVIDENCE_NOT_PASS: Required CI checks are not passing on current revision ${current_rev}. Current status: ${status.status}`);
  }

  return {is_allowed:true,reason:'CI_CHECKS_PASSED',evidence:status};
}
