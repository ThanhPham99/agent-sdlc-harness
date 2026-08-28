#!/usr/bin/env node
// PreToolUse token-hygiene guard: nudges unfiltered test/log commands toward
// a bounded form before their output reaches the model.
//
// MIRRORED FILE. adapters/hooks/test-output-guard.mjs is authoritative and
// hooks/test-output-guard.mjs is a byte-for-byte copy kept in step by
// scripts/gen-activation-assets.mjs and checked by scripts/validate-root-sync.mjs.
// Edit the adapters/ copy.
//
// This exists because full test/log output is one of the fastest ways a
// session's context grows: a real suite run under `npm test` or a `cat` of a
// production log can be tens of thousands of tokens, most of it irrelevant
// once the model has to reason about it. The fix has to happen before the
// command runs -- asking the model to summarize after it has already read
// the raw output is too late to save the input tokens that read cost.
//
// Like the safety guard, a false positive here is the expensive failure: a
// developer denied on a command that was already reasonable learns to ignore
// or disable this hook. So the match stays narrow -- specific, well-known
// test runners and log dumps -- and anything that looks even loosely bounded
// (piped into a filtering tool, a quiet/reporter flag, a line cap, or
// redirected to a file) passes through untouched.
let raw='';for await (const c of process.stdin)raw+=c;
let p={};try{p=JSON.parse(raw||'{}')}catch{process.exit(0)}
const DISABLED=v=>['0','false','no','off','disabled'].includes(String(v??'').trim().toLowerCase());
if(DISABLED(process.env.AGENT_SDLC_TEST_OUTPUT_GUARD))process.exit(0);

const name=p.tool_name||p.toolName||p.toolCall?.name||'';
const input=p.tool_input||p.toolInput||p.toolCall?.args||{};
const command=String(input.command||input.CommandLine||input.script||input.cmd||'');

const SHELL_TOOL=/bash|shell|powershell|pwsh|cmd|command|exec|terminal|process|run/i;
if(!command||!(SHELL_TOOL.test(name)||name===''))process.exit(0);

const norm=command.replace(/["'`]/g,'');

// Commands whose default output is routinely large enough to matter: test
// runners across common ecosystems, plus the two log-dump shapes that are
// unbounded by construction. `(?!:)` on the npm/yarn/pnpm "test" token keeps
// this off named scripts like "npm run test:integrity", which are not
// necessarily verbose and are not what this rule is about.
const VERBOSE_PRODUCER=/\b(?:npm\s+(?:test(?!:)|run\s+test(?!:))|yarn\s+test(?!:)|pnpm\s+test(?!:)|npx\s+(?:jest|vitest|mocha)|jest|vitest|mocha|pytest|go\s+test|mvn\s+test|gradle\s+test|gradlew\s+test|cargo\s+test|dotnet\s+test|rspec|phpunit|ctest)\b/i;
const LOG_DUMP=/\bcat\s+[^|>\n]*\.log\b|\bdocker\s+logs\b(?!.*--tail)|\bkubectl\s+logs\b(?!.*--tail)/i;

if(!VERBOSE_PRODUCER.test(norm)&&!LOG_DUMP.test(norm))process.exit(0);

// Anything that already looks bounded: piped into a filtering tool, a
// quiet/reporter/line-limiting flag, or redirected away from the conversation.
//
// The redirect clause used to be `>\s*[\w./-]+\.(log|txt|out|json)`, which
// demanded a literal path in four extensions. That denied every ordinary way
// of writing one -- `> "$LOG/run.log"`, `> ~/logs/run.log`, `> C:\tmp\run.log`,
// `> /tmp/go-out`, `> report.md` -- and, worst of all, `> /dev/null`, which
// sends nothing to the conversation at all. The denial message tells the
// caller to redirect to a file; the rule then refused the redirect. That is
// the failure this guard's own header calls the expensive one, because it is
// what teaches someone to switch the hook off.
//
// What matters is only that stdout goes somewhere other than the transcript,
// so the target is any token. `(?!&)` is what keeps `2>&1` out: merging stderr
// into stdout is not a redirect away, and that case stays denied.
const REDIRECTED=/>>?\s*(?!&)[^\s|;&<>]+/;
const ALREADY_BOUNDED=/\|\s*(?:grep|egrep|fgrep|awk|sed|head|tail|tee|jq|wc|less|more|cut)\b|--reporter[= ]?(?:dot|min|line|tap|silent)\b|--silent\b|--quiet\b|(?:^|\s)-q(?:\s|$)|--tail[= ]?\d+|--lines[= ]?\d+|-n\s*\d+|--bail\b/i;
if(ALREADY_BOUNDED.test(norm)||REDIRECTED.test(norm))process.exit(0);

console.log(JSON.stringify({hookSpecificOutput:{
  hookEventName:'PreToolUse',
  permissionDecision:'deny',
  permissionDecisionReason:'Agent SDLC token-hygiene guard: this command’s raw output is usually too large to be worth reading in full, and most of it will not be relevant. Re-run it bounded, for example pipe test output through grep -A 5 -E "(FAIL|ERROR|error:)" | head -120, use the runner’s quiet/reporter flag, or bound a log dump with --tail N / tail -n N. If the full output is genuinely needed, redirect it to a file first and read back only the part that matters.'
}}));
