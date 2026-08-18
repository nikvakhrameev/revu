import type { RevuError, RevuErrorCode } from '@revu/plan-schema';

// Wire types between CLI and daemon. The daemon mirrors CLI commands 1:1.

export const DEFAULT_DAEMON_PORT = 7388;
export const DEFAULT_INSTANCE_PORTS = { from: 7400, to: 7463 };

export interface TaskRef {
  /** Absolute path anywhere inside the repository. */
  repoPath: string;
  /** Source branch; defaults to the currently checked-out branch. */
  source?: string;
  /** Base branch; defaults to origin/HEAD -> main -> master. */
  base?: string;
}

export interface ReviewStartRequest extends TaskRef {
  allowDirty?: boolean;
  open?: boolean;
  /** Generation cursor validated fail-fast (CURSOR_INVALID) before launching. */
  since?: number;
}

export interface ReviewStartResponse {
  taskKey: string;
  url: string;
  port: number;
  /** true when an already-running instance was reused as-is */
  reused: boolean;
  /** true when the instance was restarted because the branch head moved */
  restarted: boolean;
  baseSha: string;
  targetSha: string;
  /** Task generation after launch completes (post injection/drain) — the review baseline. */
  generation: number;
}

export interface TaskSummary {
  taskKey: string;
  repositoryId: string;
  repoRoot: string;
  source: string;
  base: string;
  port: number;
  status: 'running' | 'finished' | 'stopped';
  url?: string;
  baseSha: string;
  targetSha: string;
  updatedAt: string;
}

export interface CommentAddRequest extends TaskRef {
  imports: unknown[];
}

export interface CommentRemoveRequest extends TaskRef {
  /** Thread, message, staged import or resolved thread ids. */
  ids: string[];
}

/** Removal is idempotent: unknown ids are reported, not an error. */
export interface CommentRemoveResponse {
  removedThreads: string[];
  removedMessages: string[];
  removedStaged: string[];
  removedResolved: string[];
  notFound: string[];
  /** Task generation after the removal (bumped only when something was removed). */
  generation: number;
}

/** POST /api/comment/add — the live path spreads difit's import result. */
export interface CommentAddResponse {
  /** Live path: generation stamped onto the batch (N+1 under attribution).
   *  Staged path: the current, unbumped generation (bump happens at drain). */
  generation: number;
  /** Present (true) when the instance was down and the batch was staged. */
  staged?: boolean;
  count?: number;
  [key: string]: unknown;
}

/** GET /api/comment/get — full state, or a delta of items stamped > `since`.
 *  Delta threads are returned whole, identical in shape to the full response. */
export interface CommentGetResponse {
  threads: unknown[];
  capturedAt: string | null;
  headSha: string | null;
  resolved: unknown[];
  /** Current task generation — the client's next cursor. */
  generation: number;
}

export interface PlanSetRequest extends TaskRef {
  plan: unknown;
}

export interface StaleReportEntry {
  pageId: string;
  refIndex: number;
  file: string;
  lines: { start: number; end: number };
  side?: 'old' | 'new';
  reason: 'content-changed' | 'file-missing' | 'lines-out-of-range';
}

export function revuError(code: RevuErrorCode, message: string, details?: unknown): RevuError {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export const ERROR_EXIT_CODES: Record<RevuErrorCode, number> = {
  INVALID_ARGS: 2,
  DAEMON_UNREACHABLE: 3,
  DAEMON_ALREADY_RUNNING: 0,
  TASK_NOT_FOUND: 4,
  INSTANCE_NOT_RUNNING: 5,
  DIRTY_WORKTREE: 6,
  PORT_TAKEN: 7,
  PLAN_VALIDATION_FAILED: 8,
  PLAN_NOT_FOUND: 9,
  GIT_ERROR: 10,
  GLAB_ERROR: 11,
  COMMENT_VALIDATION_FAILED: 12,
  CURSOR_INVALID: 13,
  INTERNAL: 1,
};
