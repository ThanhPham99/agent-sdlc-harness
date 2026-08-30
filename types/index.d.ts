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