// The local gate, as data.
//
// `npm run check` was a 21-link `&&` chain. Three things were wrong with that
// shape, and none of them were the suites:
//   - it stopped at the first failure, so a run told you about one broken suite
//     at a time when a change had broken three;
//   - every suite waited for the previous one even though almost all of them
//     are independent -- separate temp fixtures, separate report files, no
//     shared mutable state -- so the gate's wall-clock was the sum of its parts;
//   - the chain WAS the dependency declaration, so the only way to read the
//     real ordering constraints was to infer them from a string.
//
// The ordering constraints are now stated instead of implied. Stages run in
// sequence; the suites within a stage run concurrently. A suite belongs in its
// own stage only when something real forces it, and each one below says what.
//
// scripts/run-check.mjs executes this, and scripts/validate-ci-coverage.mjs
// checks it against .github/workflows/ci.yml -- so the plan is the single
// source of truth for both what the local gate runs and what CI must gate.
export const STAGES=[
  {
    name:'offline',
    // Everything that needs no built package. Each suite writes only its own
    // evals/*.json report and works in mkdtemp fixtures, so concurrency here is
    // safe; the only shared reads are policy/registry files nothing mutates.
    parallel:['test','test:integrity','test:activation','test:gates','test:tasks','test:alpha6',
      'test:cli-contract','test:normalize','test:provider','test:compat','test:mcp',
      'test:detection','test:dev-link','test:prompt-caching','test:worktree','test:dashboard',
      'test:parallel','test:secret-scan','test:budget','test:tui','test:fallback','test:memory',
      'test:flaky','test:mcp-gateway','test:test-impact','test:pr-synthesizer','test:security-linter',
      'test:error-triage','test:webhook','test:sse','test:dead-code','test:arch-linter',
      'test:mutation','test:simulator']
  },
  {
    name:'build',
    // Alone: it deletes and rewrites dist/ wholesale, and the next stage reads it.
    parallel:['build']
  },
  {
    name:'packaged',
    // Readers of dist/. They only read it, so they run together.
    parallel:['validate:github','test:github-installers','test:qualification-harness',
      'test:qualification-transport','verify:dist']
  },
  {
    name:'coverage',
    // Alone, and last before hygiene: test:coverage re-runs the offline stage's
    // own suites under NODE_V8_COVERAGE, and those re-runs write the same
    // evals/*.json files. Concurrent with the originals, the two would race for
    // the same report.
    parallel:['test:coverage']
  },
  {
    name:'hygiene',
    // Strictly last: it restores the tracked reports every stage above rewrote.
    parallel:['restore-tracked-reports']
  }
];

/** Every script the plan runs, in stage order. */
export const planScripts=()=>STAGES.flatMap(s=>s.parallel);
