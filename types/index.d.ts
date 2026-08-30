// TypeScript Type Definitions for Agent SDLC Harness (v3.0.0-alpha6)

export type SDLCStage =
  | 'INTAKE'
  | 'REQUIREMENTS'
  | 'DESIGN'
  | 'PLAN'
  | 'IMPLEMENT'
  | 'VERIFY'
  | 'REVIEW'
  | 'RELEASE'
  | 'DEPLOY'
  | 'CLOSE';

export type TaskStatus =
  | 'PLANNED'
  | 'QUEUED'
  | 'ACTIVE'
  | 'RUNNING'
  | 'VERIFYING'
  | 'SPEC_REVIEW'
  | 'QUALITY_REVIEW'
  | 'DONE'
  | 'FAILED'
  | 'BLOCKED'
  | 'INVALIDATED';

export type RiskProfile = 'FAST' | 'STANDARD' | 'STRICT';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TaskScope {
  write?: string[];
  read_only?: string[];
  forbidden?: string[];
  interfaces?: string[];
  modules?: string[];
}

export interface TaskVerification {
  strategy?: 'TARGETED_ONLY' | 'TARGETED_THEN_FULL' | 'FULL_ONLY';
  targeted_tests?: string[];
  full_suite?: string[];
  coverage_required?: boolean;
}

export interface SDLCTask {
  task_id: string;
  goal?: string;
  title?: string;
  description?: string;
  category?: string;
  status: TaskStatus;
  attempt?: number;
  scope?: TaskScope;
  verification?: TaskVerification;
  base_revision?: string;
  diff_hash?: string | null;
  evidence_refs?: string[];
  risk?: {
    profile?: RiskProfile;
    security?: RiskLevel;
    data?: RiskLevel;
    destructive_data_change?: boolean;
  };
}

export interface SDLCRun {
  schema: string;
  run_id: string;
  objective: string;
  state: SDLCStage;
  workflow: string;
  profile?: RiskProfile;
  revision?: number;
  target_branch?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TaskWorkspace {
  schema: string;
  run_id: string;
  task_id: string;
  mode: 'shared-readonly' | 'isolated-worktree' | 'provider-sandbox';
  root: string;
  branch?: string;
  base_revision?: string;
  commit_sha?: string | null;
  writable: boolean;
  writer?: string;
  status: 'ACTIVE' | 'CLEANED';
  checkpoints?: Array<{
    label: string;
    time: string;
    diff_hash: string;
  }>;
}

export interface ParallelPlan {
  decision: 'PARALLEL_BOUNDED' | 'SERIAL';
  max_parallel_agents: number;
  conflicts: Array<[string, string]>;
  tasks: Array<{
    id: string;
    read_only: boolean;
    write_set: string[];
    interface_set: string[];
    estimated_seconds: number;
  }>;
  reason: string;
}

export interface BudgetLimits {
  max_cost_usd?: number;
  max_tokens?: number;
  max_retries_per_task?: number;
}

export interface BudgetCircuitBreakerResult {
  schema: 'agent-sdlc/budget-circuit-breaker/v1';
  run_id: string;
  tripped: boolean;
  status: 'CIRCUIT_BREAKER_TRIPPED' | 'BUDGET_OK';
  current_tokens: number;
  current_cost_usd: number;
  limits: BudgetLimits;
  reasons: string[];
}

export interface SecretScanFinding {
  id: string;
  matched: string;
  index: number;
}

export interface SecretScanResult {
  clean: boolean;
  findings_count: number;
  findings: SecretScanFinding[];
}

export interface SymbolLocation {
  path: string;
  line: number;
  kind: 'function' | 'class' | 'interface' | 'variable' | 'type' | 'export';
  is_test?: boolean;
}

export interface RepoIntelligence {
  schema: 'agent-sdlc/repo-intelligence/v1';
  project_root: string;
  revision: string | null;
  capability?: {
    tier: 'AST_LSP' | 'REGEX_HEURISTIC' | 'FALLBACK';
  };
  stale: boolean;
  counts?: {
    files: number;
    symbols: number;
  } | null;
}

export interface MinimalChangeSurface {
  schema?: string;
  capability_tier?: string;
  revision?: string | null;
  objective: string;
  keywords: string[];
  symbols: Array<{
    symbol: string;
    score: number;
    matched: string[];
    paths: string[];
  }>;
  files: string[];
  dependent_files: string[];
  tests: string[];
  modules: string[];
  public_interfaces: string[];
  exported_symbols: string[];
  data_entities: string[];
  bounded: boolean;
  empty_reason: string | null;
}

export interface TransitiveImpactResult {
  query: 'findTransitiveImpact';
  seeds: string[];
  direct_dependents: string[];
  transitive_dependents: Array<{
    path: string;
    depth: number;
    direct: boolean;
  }>;
  total_impacted_files: number;
}

export interface ImpactedTest {
  path: string;
  depth: number;
  reason: string;
  strength: 'STRONG' | 'MEDIUM' | 'WEAK';
}

export interface TestImpactResult {
  query: 'findImpactedTests';
  modified_seeds: string[];
  impacted_files_count: number;
  impacted_tests: ImpactedTest[];
  impacted_tests_count: number;
  total_repo_tests: number;
  test_selection_ratio: number;
  recommended_test_files: string[];
}

export interface SecurityLintFinding {
  rule_id: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  line: number;
  matched: string;
}

export interface SecurityLintReport {
  schema: 'agent-sdlc/security-lint-report/v1';
  filename: string;
  clean: boolean;
  risk_level: 'HIGH' | 'MEDIUM' | 'LOW';
  findings_count: number;
  findings: SecurityLintFinding[];
}

export interface ErrorTriageResult {
  schema: 'agent-sdlc/error-triage/v1';
  category: 'SYNTAX_ERROR' | 'RUNTIME_EXCEPTION' | 'TEST_FAILURE' | 'TIMEOUT' | 'UNKNOWN';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  fingerprint: string;
  suggested_action: string;
  extracted_stack?: string[];
}

export interface AdaptiveFallbackResult {
  schema: 'agent-sdlc/adaptive-fallback-validation/v1' | 'agent-sdlc/task-fallback/v1';
  resumed: boolean;
  run_id?: string;
  task_id?: string;
  original_provider?: string | null;
  fallback_provider?: string | null;
  failure_class?: string;
  fallback_reason?: string;
}

export interface FailureMemoryRecord {
  schema: 'agent-sdlc/failure-memory-validation/v1' | 'agent-sdlc/failure-memory/v1';
  fingerprint: string;
  task_id: string;
  occurrence_count: number;
  resolution_pattern?: string;
}

export interface FlakyDetectorResult {
  schema: 'agent-sdlc/flaky-detector-validation/v1' | 'agent-sdlc/flaky-detector/v1';
  is_flaky: boolean;
  flaky_tests: Array<{
    test_name: string;
    pass_rate: number;
    runs: number;
  }>;
}

export interface MCPGatewayRoute {
  name: string;
  provider: string;
  auth_required: boolean;
  rate_limit?: number;
}

export interface PRSynthesizerResult {
  schema: 'agent-sdlc/pr-synthesizer-validation/v1' | 'agent-sdlc/pr-synthesis/v1';
  title: string;
  body: string;
  branch: string;
  checklist: string[];
}

export interface TuiDashboardOptions {
  project?: { project?: string };
  state?: { stage?: string };
  runs?: SDLCRun[];
  tasks?: SDLCTask[];
  metrics?: {
    tasks?: {
      total_tokens?: number;
      total_cost_usd?: number;
    };
  } | null;
  version?: string;
}