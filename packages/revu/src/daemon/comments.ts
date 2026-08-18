// Agent comment imports: strict anchor validation, git-backed codeSnapshot
// enrichment and id-based removal from the persisted store. Git access is
// injected so the module is testable without a repo.

export type Side = 'old' | 'new';

export interface LineRange {
  start: number;
  end: number;
}

export type CommentValidationErrorCode =
  | 'IMPORT_INVALID'
  | 'IMPORT_ID_MISSING'
  | 'IMPORT_AUTHOR_MISSING'
  | 'ANCHOR_FILE_NOT_FOUND'
  | 'ANCHOR_LINES_OUT_OF_RANGE'
  | 'REPLY_THREAD_NOT_FOUND';

export interface CommentValidationError {
  code: CommentValidationErrorCode;
  /** `imports[<index>]` */
  path: string;
  message: string;
}

export interface CommentValidationResult {
  ok: boolean;
  errors: CommentValidationError[];
}

/** A thread's anchor with the line form normalized to a range. */
export interface ThreadAnchor {
  filePath: string;
  side: Side;
  lines: LineRange;
}

/**
 * Git access on the task's pinned revisions: side "new" resolves against the
 * target sha, side "old" against the base sha.
 */
export interface CommentResolverContext {
  /** Line count of the file on that side, or null when it does not exist there. */
  getLineCount(filePath: string, side: Side): Promise<number | null> | number | null;
  /** Blob lines as `git show` returns them (trailing empty element included). */
  getLines(filePath: string, side: Side): Promise<string[] | null> | string[] | null;
}

interface ParsedImport extends ThreadAnchor {
  type: 'thread' | 'reply';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** `line: N` and `{start, end}` are the same anchor; both normalize to a range. */
function parseLine(value: unknown): LineRange | null {
  if (isPositiveInt(value)) return { start: value, end: value };
  if (!isRecord(value)) return null;
  if (!isPositiveInt(value.start) || !isPositiveInt(value.end)) return null;
  if (value.start > value.end) return null;
  return { start: value.start, end: value.end };
}

/** filePath + position of a thread-shaped record, or null when unusable. */
function readAnchor(entry: Record<string, unknown>): ThreadAnchor | null {
  if (!isNonEmptyString(entry.filePath)) return null;
  const position = entry.position;
  if (!isRecord(position)) return null;
  if (position.side !== 'old' && position.side !== 'new') return null;
  const lines = parseLine(position.line);
  if (!lines) return null;
  return { filePath: entry.filePath, side: position.side, lines };
}

function anchorsMatch(a: ThreadAnchor, b: ThreadAnchor): boolean {
  return (
    a.filePath === b.filePath &&
    a.side === b.side &&
    a.lines.start === b.lines.start &&
    a.lines.end === b.lines.end
  );
}

/**
 * Anchors of every thread in a mixed list of stored threads (no `type` field)
 * and staged comment imports. Unusable entries are skipped: they are not the
 * batch under validation.
 */
export function collectThreadAnchors(entries: unknown[]): ThreadAnchor[] {
  const anchors: ThreadAnchor[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.type !== undefined && entry.type !== 'thread') continue;
    const anchor = readAnchor(entry);
    if (anchor) anchors.push(anchor);
  }
  return anchors;
}

function parseImport(
  input: unknown,
  path: string,
): { value: ParsedImport | null; errors: CommentValidationError[] } {
  if (!isRecord(input)) {
    return {
      value: null,
      errors: [{ code: 'IMPORT_INVALID', path, message: 'import must be a JSON object' }],
    };
  }

  const errors: CommentValidationError[] = [];
  const invalid = (message: string): void => {
    errors.push({ code: 'IMPORT_INVALID', path, message });
  };

  const type = input.type;
  if (type !== 'thread' && type !== 'reply') {
    invalid(`type must be "thread" or "reply", got ${JSON.stringify(type)}`);
  }
  if (!isNonEmptyString(input.filePath)) {
    invalid('filePath must be a non-empty string');
  }
  if (!isNonEmptyString(input.body)) {
    invalid('body must be a non-empty string');
  }

  // The CLI is the agent channel: comments without id/author break feedback
  // classification downstream, so they are hard errors here.
  if (!isNonEmptyString(input.id)) {
    errors.push({
      code: 'IMPORT_ID_MISSING',
      path,
      message: 'id must be a non-empty string (agent comments are identified by it)',
    });
  }
  if (!isNonEmptyString(input.author)) {
    errors.push({
      code: 'IMPORT_AUTHOR_MISSING',
      path,
      message: 'author must be a non-empty string (agent comments are attributed by it)',
    });
  }

  let side: Side | null = null;
  let lines: LineRange | null = null;
  const position = input.position;
  if (!isRecord(position)) {
    invalid('position must be an object with side and line');
  } else {
    if (position.side !== 'old' && position.side !== 'new') {
      invalid(`position.side must be "old" or "new", got ${JSON.stringify(position.side)}`);
    } else {
      side = position.side;
    }
    lines = parseLine(position.line);
    if (!lines) {
      invalid(
        'position.line must be a positive integer or {start, end} positive integers with start <= end',
      );
    }
  }

  if ((type !== 'thread' && type !== 'reply') || !isNonEmptyString(input.filePath)) {
    return { value: null, errors };
  }
  if (side === null || lines === null) return { value: null, errors };
  return { value: { type, filePath: input.filePath, side, lines }, errors };
}

/**
 * All-or-nothing validation of a comment import batch: structure, id/author,
 * anchor existence on the pinned revisions, and reply targets. A reply may
 * target a persisted or staged thread (via `existingThreads`) or a thread
 * import earlier in the same batch.
 */
export async function validateCommentImports(
  imports: unknown[],
  ctx: CommentResolverContext,
  existingThreads: ThreadAnchor[],
): Promise<CommentValidationResult> {
  const errors: CommentValidationError[] = [];
  const known = [...existingThreads];

  for (let i = 0; i < imports.length; i++) {
    const path = `imports[${i}]`;
    const parsed = parseImport(imports[i], path);
    errors.push(...parsed.errors);
    if (!parsed.value) continue;
    const { type, filePath, side, lines } = parsed.value;

    const lineCount = await ctx.getLineCount(filePath, side);
    if (lineCount === null) {
      errors.push({
        code: 'ANCHOR_FILE_NOT_FOUND',
        path,
        message: `file "${filePath}" not found on the ${side} side`,
      });
      continue;
    }
    if (lines.end > lineCount) {
      errors.push({
        code: 'ANCHOR_LINES_OUT_OF_RANGE',
        path,
        message: `lines ${lines.start}-${lines.end} exceed file length ${lineCount} of "${filePath}"`,
      });
      continue;
    }

    const anchor: ThreadAnchor = { filePath, side, lines };
    if (type === 'thread') {
      known.push(anchor);
      continue;
    }
    if (!known.some((k) => anchorsMatch(k, anchor))) {
      errors.push({
        code: 'REPLY_THREAD_NOT_FOUND',
        path,
        message: `no thread to reply to at "${filePath}" lines ${lines.start}-${lines.end} on the ${side} side`,
      });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [] };
}

// ---------- Removal ----------

/** Structural shape the removal helper needs; the daemon passes StoredThread. */
export interface RemovableThread {
  id: string;
  messages: Array<{ id: string }>;
}

export interface StoreRemovalInput<
  T extends RemovableThread,
  R extends { thread: T } = { thread: T; resolvedAt: string },
> {
  /** Threads from the last snapshot (threads.json). */
  threads: T[];
  /** Raw comment imports still queued for the next instance (staging.json). */
  staging: unknown[];
  /** Archived threads resolved in the UI (resolved.json). */
  resolved: R[];
}

export interface StoreRemovalResult<
  T extends RemovableThread,
  R extends { thread: T } = { thread: T; resolvedAt: string },
> extends StoreRemovalInput<T, R> {
  removedThreads: string[];
  removedMessages: string[];
  removedStaged: string[];
  removedResolved: string[];
  notFound: string[];
  threadsChanged: boolean;
  stagingChanged: boolean;
  resolvedChanged: boolean;
}

/**
 * Removal of comments from the persisted task store by id. An id may name a
 * thread, a single message inside a thread, a staged import or an archived
 * resolved thread; every place it matches is removed. A thread left without
 * messages goes away with its last message. Ids that match nothing come back
 * as `notFound` — removal is idempotent, not an error.
 */
export function applyStoreRemovals<T extends RemovableThread, R extends { thread: T }>(
  input: StoreRemovalInput<T, R>,
  ids: string[],
): StoreRemovalResult<T, R> {
  const unique = [...new Set(ids)];
  const wanted = new Set(unique);
  const removedThreads: string[] = [];
  const removedMessages: string[] = [];
  const removedStaged: string[] = [];
  const removedResolved: string[] = [];

  const threads: T[] = [];
  let threadsChanged = false;
  for (const thread of input.threads) {
    if (wanted.has(thread.id)) {
      removedThreads.push(thread.id);
      threadsChanged = true;
      continue;
    }
    const kept = thread.messages.filter((message) => !wanted.has(message.id));
    if (kept.length === thread.messages.length) {
      threads.push(thread);
      continue;
    }
    threadsChanged = true;
    for (const message of thread.messages) {
      if (wanted.has(message.id)) removedMessages.push(message.id);
    }
    if (kept.length === 0) {
      removedThreads.push(thread.id);
      continue;
    }
    threads.push({ ...thread, messages: kept });
  }

  const staging = input.staging.filter((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !wanted.has(entry.id)) return true;
    removedStaged.push(entry.id);
    return false;
  });

  const resolved = input.resolved.filter((entry) => {
    if (!wanted.has(entry.thread.id)) return true;
    removedResolved.push(entry.thread.id);
    return false;
  });

  const removed = new Set([
    ...removedThreads,
    ...removedMessages,
    ...removedStaged,
    ...removedResolved,
  ]);
  return {
    threads,
    staging,
    resolved,
    removedThreads,
    removedMessages,
    removedStaged,
    removedResolved,
    notFound: unique.filter((id) => !removed.has(id)),
    threadsChanged,
    stagingChanged: staging.length !== input.staging.length,
    resolvedChanged: resolved.length !== input.resolved.length,
  };
}

async function cutSnapshot(
  ctx: CommentResolverContext,
  anchor: ThreadAnchor,
): Promise<string | null> {
  const blobLines = await ctx.getLines(anchor.filePath, anchor.side);
  if (blobLines === null) return null;
  // `git show` output ends with a trailing newline -> last split element is ''.
  const effectiveLineCount =
    blobLines.length > 0 && blobLines[blobLines.length - 1] === ''
      ? blobLines.length - 1
      : blobLines.length;
  if (anchor.lines.start > effectiveLineCount) return null;
  const end = Math.min(anchor.lines.end, effectiveLineCount);
  return blobLines.slice(anchor.lines.start - 1, end).join('\n');
}

/**
 * Attaches the anchored source lines to thread imports that carry no snapshot:
 * without one the difit UI can never mark an agent thread outdated. Replies
 * hang off their thread and carry no snapshot.
 */
export async function enrichCommentImports(
  imports: unknown[],
  ctx: CommentResolverContext,
): Promise<unknown[]> {
  const enriched: unknown[] = [];
  for (const entry of imports) {
    if (!isRecord(entry) || entry.type !== 'thread' || entry.codeSnapshot !== undefined) {
      enriched.push(entry);
      continue;
    }
    const anchor = readAnchor(entry);
    const content = anchor ? await cutSnapshot(ctx, anchor) : null;
    enriched.push(content === null ? entry : { ...entry, codeSnapshot: { content } });
  }
  return enriched;
}
