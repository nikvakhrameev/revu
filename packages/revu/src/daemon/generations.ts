// Incremental review generations: a per-task monotonic counter (meta.json
// `generation`) stamped onto threads and resolved entries at their last
// substantive change. Pure diff/stamp/filter logic over injected data — no
// git, no fs — so it is testable without a repository.

/** The slice of a message that counts as substantive. */
export interface ProjectedMessage {
  id: string;
  body: string;
  author?: string;
}

/** The slice of a thread that counts as substantive, plus its stamp. */
export interface ProjectedThread {
  id: string;
  filePath: string;
  /** Stamp of the last substantive change; absent reads as 0. */
  generation?: number;
  messages: ProjectedMessage[];
}

function messageEquals(a: ProjectedMessage, b: ProjectedMessage): boolean {
  return a.id === b.id && a.body === b.body && a.author === b.author;
}

/**
 * Normalized projection equality: `{id, filePath, messages[].{id, body, author}}`.
 * Deliberately excluded: createdAt/updatedAt (travel through re-import
 * round-trips), codeSnapshot (recomputed when code moves), position (difit may
 * re-anchor on a new diff). A thread "changed" iff this slice changed.
 */
export function projectionEquals(a: ProjectedThread, b: ProjectedThread): boolean {
  if (a.id !== b.id || a.filePath !== b.filePath) return false;
  if (a.messages.length !== b.messages.length) return false;
  return a.messages.every((m, i) => {
    const other = b.messages[i];
    return other !== undefined && messageEquals(m, other);
  });
}

/**
 * "Fully explained by batch ids": a new thread whose id is in the batch and
 * whose messages are all batch writes (difit gives the root message the thread
 * import's id), or an existing thread that only gained messages whose ids are
 * all in the batch. Anything else in the diff is foreign.
 */
function explainedByBatch(
  prev: ProjectedThread | undefined,
  next: ProjectedThread,
  batchIds: ReadonlySet<string>,
): boolean {
  if (!prev) {
    return (
      batchIds.has(next.id) && next.messages.every((m) => m.id === next.id || batchIds.has(m.id))
    );
  }
  if (prev.filePath !== next.filePath) return false;
  if (next.messages.length < prev.messages.length) return false;
  for (let i = 0; i < prev.messages.length; i++) {
    const p = prev.messages[i];
    const n = next.messages[i];
    if (p === undefined || n === undefined || !messageEquals(p, n)) return false;
  }
  return next.messages.slice(prev.messages.length).every((m) => batchIds.has(m.id));
}

export interface StampOutcome<T extends ProjectedThread> {
  /** `next` threads with stamps: unchanged carry the previous stamp forward,
   *  changed/new get a fresh one. */
  threads: Array<T & { generation: number }>;
  /** Counter value after the snapshot (advanced past the highest stamp used). */
  generation: number;
  /** true iff the diff was non-empty by the projection. */
  bumped: boolean;
  /** Stamp for threads that disappeared in this snapshot (moved to resolved):
   *  the snapshot's "foreign" generation under attribution. */
  resolvedStamp: number;
  /** Generation covering the agent batch — what `comment add` returns (N+1
   *  under attribution; the unchanged counter when the diff was empty). */
  batchGeneration: number;
}

/**
 * Diff `prev` (threads.json on disk, stamped) against `next` (fresh from
 * difit) by the normalized projection and assign stamps.
 *
 * - Empty diff (including disappearances): no bump; every stamp carried over.
 * - Ordinary snapshot (no `batchIds` — SSE watcher, drain, sync): one shared
 *   bump N+1 for every change and disappearance.
 * - Batch snapshot (`comment add`): changes fully explained by the batch ids
 *   are stamped N+1; every other change in the same diff — concurrent user or
 *   sync activity, disappearances — is stamped N+2, so a concurrent foreign
 *   change always lands above the cursor returned to the agent.
 */
export function stampSnapshot<T extends ProjectedThread>(
  prev: readonly ProjectedThread[],
  next: readonly T[],
  currentGeneration: number,
  batchIds?: ReadonlySet<string>,
): StampOutcome<T> {
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const nextIds = new Set(next.map((t) => t.id));
  const disappearedCount = prev.filter((t) => !nextIds.has(t.id)).length;

  const changedIds = new Set<string>();
  for (const t of next) {
    const p = prevById.get(t.id);
    if (!p || !projectionEquals(p, t)) changedIds.add(t.id);
  }

  const carry = (t: T): T & { generation: number } => ({
    ...t,
    generation: prevById.get(t.id)?.generation ?? 0,
  });

  if (changedIds.size === 0 && disappearedCount === 0) {
    return {
      threads: next.map(carry),
      generation: currentGeneration,
      bumped: false,
      resolvedStamp: currentGeneration,
      batchGeneration: currentGeneration,
    };
  }

  if (!batchIds) {
    const bump = currentGeneration + 1;
    return {
      threads: next.map((t) => (changedIds.has(t.id) ? { ...t, generation: bump } : carry(t))),
      generation: bump,
      bumped: true,
      resolvedStamp: bump,
      batchGeneration: bump,
    };
  }

  const mineGen = currentGeneration + 1;
  const foreignGen = currentGeneration + 2;
  const mineIds = new Set<string>();
  let foreignChanges = false;
  for (const t of next) {
    if (!changedIds.has(t.id)) continue;
    if (explainedByBatch(prevById.get(t.id), t, batchIds)) mineIds.add(t.id);
    else foreignChanges = true;
  }
  const hasForeign = foreignChanges || disappearedCount > 0;
  return {
    threads: next.map((t) => {
      if (!changedIds.has(t.id)) return carry(t);
      return { ...t, generation: mineIds.has(t.id) ? mineGen : foreignGen };
    }),
    generation: hasForeign ? foreignGen : mineGen,
    bumped: true,
    resolvedStamp: foreignGen,
    batchGeneration: mineGen,
  };
}

/** A cursor ahead of the counter means the task state was wiped/recreated —
 *  a loud CURSOR_INVALID, never a silent empty delta. */
export function isCursorAhead(since: number, generation: number): boolean {
  return since > generation;
}

/** Delta filter: exactly the items stamped strictly above the cursor.
 *  `since: 0` therefore excludes pre-migration (stamp 0) items — intended. */
export function filterByStamp<T extends { generation?: number }>(
  items: readonly T[],
  since: number,
): T[] {
  return items.filter((item) => (item.generation ?? 0) > since);
}
