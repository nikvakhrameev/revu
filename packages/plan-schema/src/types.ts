// Shared types for the revu wrapper, the difit fork and the plan format.

// ---------- Walkthrough plan (schemaVersion 1) ----------

export interface WalkthroughPage {
  id: string;
  title: string;
  body: string;
}

export interface WalkthroughPlan {
  schemaVersion: 1;
  title: string;
  pages: WalkthroughPage[];
}

export type DifitRefSide = 'old' | 'new';

/** A parsed ```difit-ref fenced block. */
export interface DifitRef {
  file: string;
  lines: { start: number; end: number };
  /** Absent means "new" (or an unchanged-file blob reference). */
  side?: DifitRefSide;
}

/** Location of a difit-ref inside a plan: page + ordinal index within that page's body. */
export interface RefLocation {
  pageId: string;
  refIndex: number;
  ref: DifitRef;
}

/** Stale marker attached by the wrapper when snippet hashes diverge. */
export interface StaleRef {
  pageId: string;
  refIndex: number;
  file: string;
  lines: { start: number; end: number };
  side?: DifitRefSide;
}

/** Payload pushed by the daemon into a managed difit instance (POST /api/walkthrough). */
export interface WalkthroughPayload {
  schemaVersion: 1;
  plan: WalkthroughPlan;
  stale: StaleRef[];
}

// ---------- Validation ----------

export interface PlanValidationError {
  code: PlanValidationErrorCode;
  /** JSON-path-ish location, e.g. "pages[2].body refs[0]" */
  path: string;
  message: string;
}

export type PlanValidationErrorCode =
  | 'ENVELOPE_INVALID'
  | 'PAGE_ID_INVALID'
  | 'PAGE_ID_DUPLICATE'
  | 'PAGE_LINK_UNRESOLVED'
  | 'REF_YAML_INVALID'
  | 'REF_KEY_UNKNOWN'
  | 'REF_FIELD_INVALID'
  | 'REF_FILE_NOT_FOUND'
  | 'REF_LINES_OUT_OF_RANGE';

export interface PlanValidationResult {
  ok: boolean;
  errors: PlanValidationError[];
}

// ---------- Daemon <-> CLI shared error codes ----------

export type RevuErrorCode =
  | 'DIRTY_WORKTREE'
  | 'PORT_TAKEN'
  | 'DAEMON_UNREACHABLE'
  | 'DAEMON_ALREADY_RUNNING'
  | 'TASK_NOT_FOUND'
  | 'INSTANCE_NOT_RUNNING'
  | 'PLAN_VALIDATION_FAILED'
  | 'PLAN_NOT_FOUND'
  | 'GIT_ERROR'
  | 'GLAB_ERROR'
  | 'INVALID_ARGS'
  | 'INTERNAL';

export interface RevuError {
  error: {
    code: RevuErrorCode;
    message: string;
    details?: unknown;
  };
}

// ---------- Managed instance identification ----------

export interface InstanceInfo {
  repositoryId: string;
  base: string;
  target: string;
  baseMode: 'direct' | 'merge-base';
  startedBy: 'wrapper' | 'cli';
  taskKey?: string;
}
