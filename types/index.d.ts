// TypeScript Type Definitions for Agent SDLC Harness (v3.0.0-rc1)

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
  | 'OBSERVE'
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

export interface RouteDecision {
  workflow: string;
  profile: RiskProfile;
  overlays: string[];
  reason_codes: string[];
  route_flags: string[];
  agent_discretion?: boolean;
  deny_language?: string[];
}

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

export interface GraphCentralityNode {
  path: string;
  module: string | null;
  is_test: boolean;
  pagerank_score: number;
  in_degree: number;
  out_degree: number;
  is_critical_core: boolean;
}

export interface GraphCentralityReport {
  schema?: string;
  query: 'calculateGraphCentrality';
  total_files: number;
  critical_core_count: number;
  critical_core_files: string[];
  centrality_ranking: GraphCentralityNode[];
  capability_tier?: string;
  revision?: string | null;
}

export interface BlastRadiusAnalysis {
  schema?: string;
  query: 'getBlastRadiusAnalysis';
  seeds: string[];
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  total_affected_count: number;
  direct_core_hits: string[];
  transitive_core_hits: string[];
  transitive_dependents_count: number;
  direct_dependents: string[];
  transitive_dependents: Array<{ path: string; depth: number; direct: boolean }>;
  capability_tier?: string;
  revision?: string | null;
}

export interface WebhookDeliveryHistoryItem {
  attempt: number;
  status: string;
  status_code: number | null;
  error: string | null;
  time: string;
}

export interface WebhookDeliveryRecord {
  delivery_id: string;
  url: string;
  event_type: string;
  status: 'DELIVERED' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'TIMEOUT' | 'FAILED_PERMANENTLY';
  attempts: number;
  history: WebhookDeliveryHistoryItem[];
  error?: string;
  duration_ms: number;
  created_at: string;
}

export interface WebhookRetryOptions {
  secret?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  jitter?: boolean;
  projectRoot?: string | null;
}

export interface SSEEventRecord {
  id: string;
  type: string;
  timestamp: string;
  [key: string]: any;
}

export interface UnreachableFileItem {
  path: string;
  module: string | null;
  exports_count: number;
}

export interface UnusedExportItem {
  file: string;
  name: string;
  type: string;
  line: number;
}

export interface GhostDependencyItem {
  name: string;
  version: string;
  type: 'production' | 'dev';
}

export interface DeadCodeReport {
  schema?: string;
  health_score: number;
  total_files: number;
  unreachable_files_count: number;
  unreachable_files: UnreachableFileItem[];
  total_exports_count: number;
  unused_exports_count: number;
  unused_exports: UnusedExportItem[];
  export_utilization_rate: number;
  ghost_dependencies_count: number;
  ghost_dependencies: GhostDependencyItem[];
}

export interface ArchViolationItem {
  type: 'PRODUCTION_IMPORTS_TEST' | 'LAYER_INVERSION' | 'FORBIDDEN_IMPORT' | 'ENCAPSULATION_LEAK';
  from: string;
  to: string;
  from_layer?: string;
  to_layer?: string;
  reason: string;
}

export interface ArchAuditReport {
  schema?: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  file_count: number;
  edge_count: number;
  circular_dependencies: string[][];
  circular_dependency_count: number;
  boundary_violations: ArchViolationItem[];
  boundary_violation_count: number;
  layer_violations_count?: number;
  forbidden_imports_count?: number;
  total_issues: number;
}

export interface MutantItem {
  id: string;
  line: number;
  type: string;
  original: string;
  mutated: string;
  status: 'KILLED' | 'SURVIVED';
  impacted_tests: string[];
}

export interface MutationReport {
  schema?: string;
  target_file: string;
  total_mutants: number;
  killed: number;
  survived: number;
  mutation_score: number;
  status: 'PASS' | 'WARN';
  impacted_test_count: number;
  impacted_tests: string[];
  mutants: MutantItem[];
}

export interface WeakSpotItem {
  file: string;
  score: number;
  survived: number;
}

export interface RepoMutationReport {
  schema?: string;
  total_files_analyzed: number;
  total_mutants: number;
  total_killed: number;
  total_survived: number;
  overall_mutation_score: number;
  status: 'PASS' | 'WARN';
  weak_spots_count: number;
  weak_spots: WeakSpotItem[];
  file_reports: MutationReport[];
}

export interface DAGConcurrencyAnalysis {
  sequential_duration_s: number;
  concurrent_duration_s: number;
  speedup_factor: number;
  concurrency_limit: number;
  wave_count: number;
  waves: string[][];
}

export interface PromptCacheSavings {
  enabled: boolean;
  cache_hit_ratio: number;
  cached_prompt_tokens: number;
  uncached_prompt_tokens: number;
  standard_prompt_cost_usd: number;
  optimized_prompt_cost_usd: number;
  estimated_savings_usd: number;
  savings_percentage: number;
}

export interface OptimizationRecommendation {
  type: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
}

export interface SimulationCaseEstimate {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  turns: number;
  duration_s: number;
}

export interface SimulationReport {
  schema?: string;
  run_id: string;
  task_count: number;
  historical_first_try_success_rate: number;
  best_case: SimulationCaseEstimate;
  expected: SimulationCaseEstimate;
  worst_case: SimulationCaseEstimate;
  concurrency_analysis: DAGConcurrencyAnalysis;
  prompt_cache_savings: PromptCacheSavings;
  recommendations: OptimizationRecommendation[];
  budget_guard: {
    configured_budget_usd: number;
    configured_max_turns: number;
    within_budget: boolean;
    warnings: string[];
  };
  task_breakdown: any[];
}