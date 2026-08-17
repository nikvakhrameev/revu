import { validatePlanStructure, type WalkthroughPlan } from '@revu/plan-schema';

import {
  computeRepositoryId,
  getCurrentBranch,
  getRepoRoot,
  isBranch,
  isWorktreeDirty,
  mergeBase,
  resolveDefaultBase,
  revParse,
} from './git.js';
import {
  getInstanceInfo,
  isOurInstance,
  isPidAlive,
  isPortListening,
  killInstance,
  spawnInstance,
} from './instances.js';
import { computePlanHashes, computeStaleReport, staleReportToRefs, validatePlanFull } from './plan.js';
import {
  computeTaskKeyHash,
  listAllTaskMetas,
  TaskStore,
  type StoredThread,
  type TaskMeta,
} from './store.js';
import { InstanceWatcher } from './watcher.js';
import {
  DEFAULT_INSTANCE_PORTS,
  type ReviewStartResponse,
  type StaleReportEntry,
  type TaskRef,
  type TaskSummary,
} from '../shared/protocol.js';

export class TaskError extends Error {
  constructor(
    readonly code:
      | 'DIRTY_WORKTREE'
      | 'PORT_TAKEN'
      | 'TASK_NOT_FOUND'
      | 'INSTANCE_NOT_RUNNING'
      | 'PLAN_VALIDATION_FAILED'
      | 'PLAN_NOT_FOUND'
      | 'GIT_ERROR'
      | 'INVALID_ARGS',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface ResolvedTask {
  repoRoot: string;
  repositoryId: string;
  source: string;
  base: string;
  taskKeyHash: string;
  store: TaskStore;
}

interface LiveTask {
  taskKeyHash: string;
  resolved: ResolvedTask;
  /** Session revision strings exactly as the difit instance resolved them. */
  session: { base: string; target: string };
  watcher: InstanceWatcher;
  port: number;
  pid: number;
  waiters: Array<{ resolve: (r: 'finished') => void; reject: (e: Error) => void }>;
  snapshotChain: Promise<void>;
}

export class Registry {
  private live = new Map<string, LiveTask>();
  private portRange: { from: number; to: number };

  constructor(portRange?: { from: number; to: number }) {
    this.portRange = portRange ?? DEFAULT_INSTANCE_PORTS;
  }

  // ---------- Task resolution ----------

  async resolveTask(ref: TaskRef): Promise<ResolvedTask> {
    if (!ref.repoPath) throw new TaskError('INVALID_ARGS', 'repoPath is required');
    let repoRoot: string;
    try {
      repoRoot = await getRepoRoot(ref.repoPath);
    } catch (e) {
      throw new TaskError('GIT_ERROR', `Not a git repository: ${ref.repoPath}`);
    }
    const repositoryId = computeRepositoryId(repoRoot);

    let source = ref.source;
    if (!source) {
      const current = await getCurrentBranch(repoRoot);
      if (!current) {
        throw new TaskError(
          'INVALID_ARGS',
          'HEAD is detached and no source branch was given; pass an explicit source branch',
        );
      }
      source = current;
    }
    if (!(await isBranch(repoRoot, source))) {
      throw new TaskError(
        'INVALID_ARGS',
        `"${source}" is not a branch. Arbitrary commit pairs (ephemeral reviews) are not supported in the MVP; use a branch.`,
      );
    }

    const base = ref.base ?? (await resolveDefaultBase(repoRoot));
    const taskKeyHash = computeTaskKeyHash(repositoryId, source, base);
    return {
      repoRoot,
      repositoryId,
      source,
      base,
      taskKeyHash,
      store: new TaskStore(repositoryId, taskKeyHash),
    };
  }

  private async resolveRevisions(t: ResolvedTask): Promise<{ baseSha: string; targetSha: string }> {
    const targetSha = await revParse(t.repoRoot, t.source);
    const baseSha = await mergeBase(t.repoRoot, t.base, t.source);
    return { baseSha, targetSha };
  }

  /** Only committed code is reviewed: block when the task's source branch is
   *  checked out and the worktree is dirty (untracked included). */
  private async guardDirty(t: ResolvedTask, allowDirty?: boolean): Promise<void> {
    if (allowDirty) return;
    const currentBranch = await getCurrentBranch(t.repoRoot);
    if (currentBranch === t.source && (await isWorktreeDirty(t.repoRoot))) {
      throw new TaskError(
        'DIRTY_WORKTREE',
        'Worktree has uncommitted or untracked changes; only committed code is reviewed. Commit first or pass --allow-dirty.',
      );
    }
  }

  // ---------- Review lifecycle ----------

  async reviewStart(
    ref: TaskRef,
    opts: { allowDirty?: boolean; open?: boolean },
  ): Promise<ReviewStartResponse> {
    const t = await this.resolveTask(ref);
    const revisions = await this.resolveRevisions(t);
    const existingLive = this.live.get(t.taskKeyHash);
    const meta = t.store.getMeta();

    // 1. A live instance we already track.
    if (existingLive && isPidAlive(existingLive.pid)) {
      const fresh =
        meta && meta.baseSha === revisions.baseSha && meta.targetSha === revisions.targetSha;
      if (fresh) {
        return this.startResponse(t, existingLive.port, revisions, { reused: true });
      }
      // Branch head moved: restart on the same port with thread re-injection.
      await this.guardDirty(t, opts.allowDirty);
      await this.stopLive(existingLive, { snapshot: true });
      const restarted = await this.launch(t, existingLive.port, revisions, opts);
      return this.startResponse(t, restarted.port, revisions, { restarted: true });
    }

    // 2. Not tracked. Maybe an orphaned child from a previous daemon run still owns the port.
    const stickyPort = meta?.port;
    if (stickyPort && (await isPortListening(stickyPort))) {
      const ours = await isOurInstance(stickyPort, t.taskKeyHash);
      if (ours) {
        await this.adopt(t, stickyPort, ours.pid ?? meta.pid ?? 0);
        // Freshness check for the adopted instance.
        if (meta.baseSha === revisions.baseSha && meta.targetSha === revisions.targetSha) {
          return this.startResponse(t, stickyPort, revisions, { reused: true });
        }
        const adopted = this.live.get(t.taskKeyHash);
        if (adopted) await this.stopLive(adopted, { snapshot: true });
        await this.launch(t, stickyPort, revisions, opts);
        return this.startResponse(t, stickyPort, revisions, { restarted: true });
      }
      throw new TaskError(
        'PORT_TAKEN',
        `Port ${stickyPort} is pinned to this task but occupied by a foreign process`,
      );
    }

    // 3. Cold start: dirty-worktree guard, then launch.
    await this.guardDirty(t, opts.allowDirty);
    const port = stickyPort ?? (await this.allocatePort());
    await this.launch(t, port, revisions, opts);
    return this.startResponse(t, port, revisions, {});
  }

  private startResponse(
    t: ResolvedTask,
    port: number,
    revisions: { baseSha: string; targetSha: string },
    flags: { reused?: boolean; restarted?: boolean },
  ): ReviewStartResponse {
    return {
      taskKey: t.taskKeyHash,
      url: `http://localhost:${port}`,
      port,
      reused: flags.reused ?? false,
      restarted: flags.restarted ?? false,
      baseSha: revisions.baseSha,
      targetSha: revisions.targetSha,
    };
  }

  private async allocatePort(): Promise<number> {
    const claimed = new Set(listAllTaskMetas().map((m) => m.port));
    for (let port = this.portRange.from; port <= this.portRange.to; port++) {
      if (claimed.has(port)) continue;
      if (await isPortListening(port)) continue;
      return port;
    }
    throw new TaskError('PORT_TAKEN', 'No free ports left in the instance port range');
  }

  private async launch(
    t: ResolvedTask,
    port: number,
    revisions: { baseSha: string; targetSha: string },
    opts: { open?: boolean },
  ): Promise<{ port: number }> {
    const { pid } = await spawnInstance({
      repoRoot: t.repoRoot,
      targetSha: revisions.targetSha,
      baseSha: revisions.baseSha,
      port,
      taskKeyHash: t.taskKeyHash,
      open: opts.open,
    });

    const now = new Date().toISOString();
    const prevMeta = t.store.getMeta();
    const meta: TaskMeta = {
      schemaVersion: 1,
      repositoryId: t.repositoryId,
      repoRoot: t.repoRoot,
      source: t.source,
      base: t.base,
      taskKeyHash: t.taskKeyHash,
      port,
      pid,
      baseSha: revisions.baseSha,
      targetSha: revisions.targetSha,
      status: 'running',
      createdAt: prevMeta?.createdAt ?? now,
      updatedAt: now,
    };
    t.store.setMeta(meta);

    const session = await this.fetchSession(port);
    const liveTask = this.track(t, port, pid, session);

    // Re-inject persisted threads, drain the staging queue, push the plan.
    await this.injectThreads(liveTask);
    await this.drainStaging(liveTask);
    await this.pushPlan(liveTask, revisions);
    return { port };
  }

  /** difit resolves revisions to its own display form; comment session keys use
   *  those resolved strings, so the daemon must query with exactly them. */
  private async fetchSession(port: number): Promise<{ base: string; target: string }> {
    const res = await fetch(`http://localhost:${port}/api/diff`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GET /api/diff on instance failed: ${res.status}`);
    const data = (await res.json()) as { baseCommitish?: string; targetCommitish?: string };
    if (!data.baseCommitish || !data.targetCommitish) {
      throw new Error('Instance /api/diff did not return resolved revisions');
    }
    return { base: data.baseCommitish, target: data.targetCommitish };
  }

  private sessionQuery(live: LiveTask): string {
    return `base=${encodeURIComponent(live.session.base)}&target=${encodeURIComponent(live.session.target)}`;
  }

  private track(
    t: ResolvedTask,
    port: number,
    pid: number,
    session: { base: string; target: string },
  ): LiveTask {
    const liveTask: LiveTask = {
      taskKeyHash: t.taskKeyHash,
      resolved: t,
      session,
      port,
      pid,
      waiters: [],
      snapshotChain: Promise.resolve(),
      watcher: new InstanceWatcher(port, {
        onCommentsChanged: () => this.queueSnapshot(liveTask),
        onReviewFinished: () => void this.handleFinish(liveTask),
        onDisconnect: () => void this.handleDisconnect(liveTask),
      }),
    };
    this.live.set(t.taskKeyHash, liveTask);
    liveTask.watcher.start();
    return liveTask;
  }

  private async adopt(t: ResolvedTask, port: number, pid: number): Promise<void> {
    const session = await this.fetchSession(port);
    this.track(t, port, pid, session);
    const meta = t.store.getMeta();
    if (meta) t.store.setMeta({ ...meta, status: 'running', pid });
  }

  // ---------- Threads: snapshots, injection, staging ----------

  private queueSnapshot(live: LiveTask): void {
    live.snapshotChain = live.snapshotChain.then(() => this.snapshot(live)).catch(() => {});
  }

  private async snapshot(live: LiveTask): Promise<void> {
    const res = await fetch(
      `http://localhost:${live.port}/api/comments-json?${this.sessionQuery(live)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) throw new Error(`comments-json failed: ${res.status}`);
    const data = (await res.json()) as { version: number; threads: StoredThread[] };
    const store = live.resolved.store;
    const prev = store.getThreads();
    const meta = store.getMeta();

    // Threads that disappeared since the previous snapshot were resolved in the UI.
    if (prev) {
      const nextIds = new Set(data.threads.map((th) => th.id));
      const disappeared = prev.threads.filter((th) => !nextIds.has(th.id));
      if (disappeared.length > 0) {
        const resolved = store.getResolved();
        const now = new Date().toISOString();
        for (const th of disappeared) {
          resolved.threads.push({ thread: th, resolvedAt: now });
        }
        store.setResolved(resolved);
        const sync = store.getSync();
        for (const th of disappeared) {
          const state = sync.threads[th.id];
          if (state && state.publishState === 'published') {
            state.publishState = 'resolved-local';
          } else if (!state) {
            sync.threads[th.id] = { origin: 'local', publishState: 'resolved-local' };
          }
        }
        store.setSync(sync);
      }
    }

    store.setThreads({
      schemaVersion: 1,
      version: data.version,
      threads: data.threads,
      capturedAt: new Date().toISOString(),
      headSha: meta?.targetSha ?? '',
    });
  }

  private threadsToImports(threads: StoredThread[]): unknown[] {
    const imports: unknown[] = [];
    for (const th of threads) {
      const [root, ...replies] = th.messages;
      if (!root) continue;
      imports.push({
        type: 'thread',
        id: th.id,
        filePath: th.filePath,
        position: th.position,
        body: root.body,
        ...(root.author ? { author: root.author } : {}),
        createdAt: th.createdAt,
        updatedAt: th.updatedAt,
        ...(th.codeSnapshot ? { codeSnapshot: th.codeSnapshot } : {}),
      });
      for (const reply of replies) {
        imports.push({
          type: 'reply',
          id: reply.id,
          filePath: th.filePath,
          position: th.position,
          body: reply.body,
          ...(reply.author ? { author: reply.author } : {}),
          createdAt: reply.createdAt,
        });
      }
    }
    return imports;
  }

  private async postImports(live: LiveTask, imports: unknown[]): Promise<unknown> {
    const res = await fetch(
      `http://localhost:${live.port}/api/comment-imports?${this.sessionQuery(live)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imports),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`comment-imports failed: ${res.status} ${JSON.stringify(body)}`);
    }
    return body;
  }

  private async injectThreads(live: LiveTask): Promise<void> {
    const threadsFile = live.resolved.store.getThreads();
    if (!threadsFile || threadsFile.threads.length === 0) return;
    await this.postImports(live, this.threadsToImports(threadsFile.threads));
  }

  private async drainStaging(live: LiveTask): Promise<void> {
    const store = live.resolved.store;
    const staging = store.getStaging();
    if (staging.imports.length === 0) return;
    await this.postImports(live, staging.imports);
    store.setStaging({ schemaVersion: 1, imports: [] });
    this.queueSnapshot(live);
  }

  private async pushPlan(
    live: LiveTask,
    revisions: { baseSha: string; targetSha: string },
  ): Promise<void> {
    const store = live.resolved.store;
    const planFile = store.getPlan();
    if (!planFile) return;
    const stale = await computeStaleReport(
      planFile,
      live.resolved.repoRoot,
      revisions.baseSha,
      revisions.targetSha,
    );
    await fetch(`http://localhost:${live.port}/api/walkthrough?${this.sessionQuery(live)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        plan: planFile.plan,
        stale: staleReportToRefs(stale),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  // ---------- Finish / stop / disconnect ----------

  private async handleFinish(live: LiveTask): Promise<void> {
    await live.snapshotChain;
    try {
      await this.snapshot(live);
    } catch {
      // instance may already be shutting down; keep the last snapshot
    }
    live.watcher.stop();
    await killInstance(live.pid);
    this.live.delete(live.taskKeyHash);
    const meta = live.resolved.store.getMeta();
    if (meta) live.resolved.store.setMeta({ ...meta, status: 'finished', pid: null });
    for (const w of live.waiters) w.resolve('finished');
    live.waiters = [];
  }

  private async handleDisconnect(live: LiveTask): Promise<void> {
    live.watcher.stop();
    this.live.delete(live.taskKeyHash);
    const meta = live.resolved.store.getMeta();
    if (meta && !isPidAlive(live.pid)) {
      live.resolved.store.setMeta({ ...meta, status: 'stopped', pid: null });
    }
    const err = new TaskError('INSTANCE_NOT_RUNNING', 'difit instance disappeared before Finish');
    for (const w of live.waiters) w.reject(err);
    live.waiters = [];
  }

  async reviewStop(ref: TaskRef): Promise<{ stopped: boolean }> {
    const t = await this.resolveTask(ref);
    const live = this.live.get(t.taskKeyHash);
    if (live) {
      await this.stopLive(live, { snapshot: true });
      return { stopped: true };
    }
    const meta = t.store.getMeta();
    if (!meta) throw new TaskError('TASK_NOT_FOUND', 'No such task');
    if (meta.pid && isPidAlive(meta.pid)) {
      await killInstance(meta.pid);
    }
    t.store.setMeta({ ...meta, status: 'stopped', pid: null });
    return { stopped: true };
  }

  private async stopLive(live: LiveTask, opts: { snapshot: boolean }): Promise<void> {
    if (opts.snapshot) {
      await live.snapshotChain;
      try {
        await this.snapshot(live);
      } catch {
        // best effort
      }
    }
    live.watcher.stop();
    await killInstance(live.pid);
    this.live.delete(live.taskKeyHash);
    const meta = live.resolved.store.getMeta();
    if (meta) live.resolved.store.setMeta({ ...meta, status: 'stopped', pid: null });
    const err = new TaskError('INSTANCE_NOT_RUNNING', 'Instance was stopped');
    for (const w of live.waiters) w.reject(err);
    live.waiters = [];
  }

  async reviewRefresh(
    ref: TaskRef,
    opts: { open?: boolean; allowDirty?: boolean },
  ): Promise<ReviewStartResponse> {
    const t = await this.resolveTask(ref);
    const meta = t.store.getMeta();
    if (!meta) throw new TaskError('TASK_NOT_FOUND', 'No such task; run review start first');
    await this.guardDirty(t, opts.allowDirty);
    const revisions = await this.resolveRevisions(t);
    const live = this.live.get(t.taskKeyHash);
    if (live) await this.stopLive(live, { snapshot: true });
    await this.launch(t, meta.port, revisions, opts);
    return this.startResponse(t, meta.port, revisions, { restarted: true });
  }

  async reviewWait(ref: TaskRef, timeoutMs: number): Promise<'finished' | 'pending'> {
    const t = await this.resolveTask(ref);
    const meta = t.store.getMeta();
    if (!meta) throw new TaskError('TASK_NOT_FOUND', 'No such task');
    if (meta.status === 'finished') return 'finished';
    const live = this.live.get(t.taskKeyHash);
    if (!live) {
      throw new TaskError('INSTANCE_NOT_RUNNING', 'Task instance is not running');
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (r: 'finished') => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        live.waiters = live.waiters.filter((w) => w !== waiter);
        resolve('pending');
      }, timeoutMs);
      live.waiters.push(waiter);
    });
  }

  async reviewList(repoPath?: string): Promise<TaskSummary[]> {
    let repoRootFilter: string | null = null;
    if (repoPath) {
      try {
        repoRootFilter = await getRepoRoot(repoPath);
      } catch {
        repoRootFilter = repoPath;
      }
    }
    const metas = listAllTaskMetas().filter(
      (m) => !repoRootFilter || m.repoRoot === repoRootFilter,
    );
    return metas.map((meta) => {
      const live = this.live.get(meta.taskKeyHash);
      return {
        taskKey: meta.taskKeyHash,
        repositoryId: meta.repositoryId,
        repoRoot: meta.repoRoot,
        source: meta.source,
        base: meta.base,
        port: meta.port,
        status: live ? 'running' : meta.status === 'running' ? 'stopped' : meta.status,
        ...(live ? { url: `http://localhost:${meta.port}` } : {}),
        baseSha: meta.baseSha,
        targetSha: meta.targetSha,
        updatedAt: meta.updatedAt,
      };
    });
  }

  // ---------- Comments ----------

  async commentAdd(ref: TaskRef, imports: unknown[]): Promise<unknown> {
    const t = await this.resolveTask(ref);
    const live = this.live.get(t.taskKeyHash);
    if (live && isPidAlive(live.pid)) {
      const result = await this.postImports(live, imports);
      this.queueSnapshot(live);
      return result;
    }
    // Dead instance: stage for the next review start.
    const staging = t.store.getStaging();
    staging.imports.push(...imports);
    t.store.setStaging(staging);
    return { staged: true, count: imports.length };
  }

  async commentGet(ref: TaskRef): Promise<unknown> {
    const t = await this.resolveTask(ref);
    const threads = t.store.getThreads();
    const resolved = t.store.getResolved();
    if (!threads && resolved.threads.length === 0 && !t.store.getMeta()) {
      throw new TaskError('TASK_NOT_FOUND', 'No such task');
    }
    return {
      threads: threads?.threads ?? [],
      capturedAt: threads?.capturedAt ?? null,
      headSha: threads?.headSha ?? null,
      resolved: resolved.threads,
    };
  }

  // ---------- Plan ----------

  /** Pinned revisions of the live instance when one runs; otherwise current git. */
  private async planRevisions(t: ResolvedTask): Promise<{ baseSha: string; targetSha: string }> {
    const live = this.live.get(t.taskKeyHash);
    const meta = t.store.getMeta();
    if (live && meta) return { baseSha: meta.baseSha, targetSha: meta.targetSha };
    return this.resolveRevisions(t);
  }

  async planValidate(ref: TaskRef, plan: unknown): Promise<{ ok: true }> {
    const t = await this.resolveTask(ref);
    const revisions = await this.planRevisions(t);
    const result = await validatePlanFull(plan, t.repoRoot, revisions.baseSha, revisions.targetSha);
    if (!result.ok) {
      throw new TaskError('PLAN_VALIDATION_FAILED', 'Plan validation failed', result.errors);
    }
    return { ok: true };
  }

  async planSet(ref: TaskRef, plan: unknown): Promise<{ ok: true; stale: StaleReportEntry[] }> {
    const t = await this.resolveTask(ref);
    const revisions = await this.planRevisions(t);
    const result = await validatePlanFull(plan, t.repoRoot, revisions.baseSha, revisions.targetSha);
    if (!result.ok) {
      throw new TaskError('PLAN_VALIDATION_FAILED', 'Plan validation failed', result.errors);
    }
    const typedPlan = plan as WalkthroughPlan;
    const hashes = await computePlanHashes(
      typedPlan,
      t.repoRoot,
      revisions.baseSha,
      revisions.targetSha,
    );
    t.store.setPlan({
      schemaVersion: 1,
      plan: typedPlan,
      hashes,
      baseSha: revisions.baseSha,
      targetSha: revisions.targetSha,
      setAt: new Date().toISOString(),
    });
    const live = this.live.get(t.taskKeyHash);
    if (live && isPidAlive(live.pid)) {
      await this.pushPlan(live, revisions);
    }
    return { ok: true, stale: [] };
  }

  async planGet(ref: TaskRef): Promise<{ plan: unknown; stale: StaleReportEntry[]; setAt: string }> {
    const t = await this.resolveTask(ref);
    const planFile = t.store.getPlan();
    if (!planFile) throw new TaskError('PLAN_NOT_FOUND', 'No plan stored for this task');
    const revisions = await this.planRevisions(t);
    const stale = await computeStaleReport(planFile, t.repoRoot, revisions.baseSha, revisions.targetSha);
    return { plan: planFile.plan, stale, setAt: planFile.setAt };
  }

  async planCheck(ref: TaskRef): Promise<{ stale: StaleReportEntry[]; fresh: boolean }> {
    const t = await this.resolveTask(ref);
    const planFile = t.store.getPlan();
    if (!planFile) throw new TaskError('PLAN_NOT_FOUND', 'No plan stored for this task');
    const revisions = await this.planRevisions(t);
    const stale = await computeStaleReport(planFile, t.repoRoot, revisions.baseSha, revisions.targetSha);
    return { stale, fresh: stale.length === 0 };
  }

  // ---------- Reconciliation & shutdown ----------

  async reconcile(): Promise<void> {
    for (const meta of listAllTaskMetas()) {
      if (meta.status !== 'running') continue;
      const alive = meta.pid !== null && isPidAlive(meta.pid);
      const info = alive ? await getInstanceInfo(meta.port) : null;
      const ours =
        info && info.startedBy === 'wrapper' && info.taskKey === meta.taskKeyHash ? info : null;
      const store = new TaskStore(meta.repositoryId, meta.taskKeyHash);
      if (!ours) {
        store.setMeta({ ...meta, status: 'stopped', pid: null });
        continue;
      }
      const t: ResolvedTask = {
        repoRoot: meta.repoRoot,
        repositoryId: meta.repositoryId,
        source: meta.source,
        base: meta.base,
        taskKeyHash: meta.taskKeyHash,
        store,
      };
      try {
        await this.adopt(t, meta.port, meta.pid ?? 0);
      } catch {
        store.setMeta({ ...meta, status: 'stopped', pid: null });
      }
    }
  }

  async shutdown(): Promise<void> {
    // Children are detached and survive daemon shutdown by design; just stop watchers.
    for (const live of this.live.values()) {
      live.watcher.stop();
      const err = new TaskError('INSTANCE_NOT_RUNNING', 'Daemon is shutting down');
      for (const w of live.waiters) w.reject(err);
      live.waiters = [];
    }
    this.live.clear();
  }

  liveCount(): number {
    return this.live.size;
  }

  getLive(taskKeyHash: string): { port: number; session: { base: string; target: string } } | null {
    const live = this.live.get(taskKeyHash);
    return live ? { port: live.port, session: live.session } : null;
  }
}
