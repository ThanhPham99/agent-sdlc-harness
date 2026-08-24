import fs from 'node:fs';
import path from 'node:path';
import {gitSha} from './util.mjs';
export function detectProject(projectRoot){const has=(x)=>fs.existsSync(path.join(projectRoot,x));let stack='unknown',commands={};if(has('package.json')){stack='node';const pkg=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'));if(pkg.scripts?.test){commands.test_full=['npm','test'];commands.test_targeted=['npm','test','--','{selector}'];}if(pkg.scripts?.build)commands.build=['npm','run','build'];}
 else if(has('pyproject.toml')||has('pytest.ini')){stack='python';commands.test_full=['python','-m','pytest'];commands.test_targeted=['python','-m','pytest','{selector}'];}
 else if(has('go.mod')){stack='go';commands.test_full=['go','test','./...'];commands.test_targeted=['go','test','{selector}'];commands.build=['go','build','./...'];}
 else if(has('Cargo.toml')){stack='rust';commands.test_full=['cargo','test'];commands.test_targeted=['cargo','test','{selector}'];commands.build=['cargo','build'];}
 return {schema:'agent-sdlc/project/v1',project:path.basename(projectRoot),created_from_git_sha:gitSha(projectRoot),stack,risk_profile:'STANDARD',default_provider:'auto',commands,context:{project_invariants:[],hot_paths:[]},approval:{mode:'risk-based'},providers:{preferred:['claude','codex','antigravity']}};}
