// Integration tests for the generation counter wired through the Registry:
// launch / re-injection / drain, snapshot stamping, attribution, removal and
// cursor validation — against a fake in-process difit instance. git and
// process management are mocked; the store is the real TaskStore on a
// throwaway REVU_HOME.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./git.js', () => ({
  GitError: class GitError extends Error {},
  getRepoRoot: vi.fn(async () => '/fake/repo'),
  computeRepositoryId: vi.fn(() => 'fakerepoid'),
  getCurrentBranch: vi.fn(async () => 'feature'),
  isBranch: vi.fn(async () => true),
  resolveDefaultBase: vi.fn(async () => 'main'),
  revParse: vi.fn(async () => 'head-1'),
  mergeBase: vi.fn(async () => 'base-1'),
  isWorktreeDirty: vi.fn(async () => false),
  getBlobLines: vi.fn(async () => [...Array.from({ length: 100 }, (_, i) => `line ${i + 1}`), '']),
  getBlobLineCount: vi.fn(async () => 100),
  hashSnippet: vi.fn(async () => 'snippet-hash'),
  fetchRefs: vi.fn(async () => {}),
}));

vi.mock('./instances.js', () => ({
  spawnInstance: vi.fn(async () => ({ pid: 4242 })),
  isPidAlive: vi.fn(() => true),
  isPortListening: vi.fn(async () => false),
  isOurInstance: vi.fn(async () => null),
  getInstanceInfo: vi.fn(async () => null),
  killInstance: vi.fn(async () => {}),
  difitCliPath: vi.fn(() => '/fake/difit'),
}));

vi.mock('./watcher.js', () => {
  type Handlers = {
    onCommentsChanged: () => void;
    onReviewFinished: () => void;
    onDisconnect: () => void;
  };
  class InstanceWatcher {
    static instances: Array<{ port: number; handlers: Handlers }> = [];
    constructor(port: number, handlers: Handlers) {
      InstanceWatcher.instances.push({ port, handlers });
    }
    start(): void {}
    stop(): void {}
  }
  return { InstanceWatcher };
});

import { revParse } from './git.js';
import { spawnInstance } from './instances.js';
import { Registry } from './registry.js';
import { computeTaskKeyHash, TaskStore, type StoredThread } from './store.js';
import { InstanceWatcher } from './watcher.js';

// ---------- Fake difit instance ----------

interface FakeMessage {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

interface FakeThread {
  id: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  position: { side: 'old' | 'new'; line: number | { start: number; end: number } };
  codeSnapshot?: { content: string; language?: string };
  messages: FakeMessage[];
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw === '' ? null : JSON.parse(raw));
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on('error', reject);
  });
}

function anchorKey(position: FakeThread['position']): string {
  const line =
    typeof position.line === 'number'
      ? { start: position.line, end: position.line }
      : position.line;
  return `${position.side}:${line.start}-${line.end}`;
}

/** Minimal difit --managed stand-in: /api/diff, /api/comments-json,
 *  /api/comment-imports (root message gets the thread import's id, like the
 *  real commentImports.ts) and /api/comment-removals. Import timestamps are
 *  always freshly generated — exactly the re-injection round-trip noise the
 *  projection must ignore. */
class FakeDifit {
  version = 1;
  threads: FakeThread[] = [];
  /** Armed hook: runs right after an import batch is applied, to simulate a
   *  user acting in the same instant (the attribution race). */
  onImports: ((imports: unknown[]) => void) | null = null;
  port = 0;
  private server: Server | null = null;
  private tick = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reset(): void {
    this.version = 1;
    this.threads = [];
    this.onImports = null;
  }

  stamp(): string {
    this.tick += 1;
    return `fake-ts-${this.tick}`;
  }

  addUserThread(opts: { id: string; line?: number; filePath?: string; body?: string }): void {
    this.threads.push({
      id: opts.id,
      filePath: opts.filePath ?? 'src/a.ts',
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
      position: { side: 'new', line: opts.line ?? 3 },
      codeSnapshot: { content: 'user snippet' },
      messages: [
        {
          id: opts.id,
          body: opts.body ?? `user note ${opts.id}`,
          author: 'nikita',
          createdAt: this.stamp(),
          updatedAt: this.stamp(),
        },
      ],
    });
    this.version += 1;
  }

  addUserReply(threadId: string, id: string, body = 'user reply'): void {
    const thread = this.threads.find((t) => t.id === threadId);
    if (!thread) throw new Error(`no fake thread ${threadId}`);
    thread.messages.push({
      id,
      body,
      author: 'nikita',
      createdAt: this.stamp(),
      updatedAt: this.stamp(),
    });
    this.version += 1;
  }

  removeThread(id: string): void {
    this.threads = this.threads.filter((t) => t.id !== id);
    this.version += 1;
  }

  private applyImports(imports: unknown[]): void {
    for (const raw of imports) {
      const imp = raw as Record<string, unknown> & {
        position: FakeThread['position'];
      };
      if (imp.type === 'thread') {
        this.threads = this.threads.filter((t) => t.id !== imp.id);
        this.threads.push({
          id: imp.id as string,
          filePath: imp.filePath as string,
          createdAt: this.stamp(),
          updatedAt: this.stamp(),
          position: imp.position,
          ...(imp.codeSnapshot
            ? { codeSnapshot: imp.codeSnapshot as { content: string } }
            : {}),
          messages: [
            {
              id: imp.id as string,
              body: imp.body as string,
              ...(imp.author ? { author: imp.author as string } : {}),
              createdAt: this.stamp(),
              updatedAt: this.stamp(),
            },
          ],
        });
      } else if (imp.type === 'reply') {
        const target = this.threads.find(
          (t) => t.filePath === imp.filePath && anchorKey(t.position) === anchorKey(imp.position),
        );
        target?.messages.push({
          id: imp.id as string,
          body: imp.body as string,
          ...(imp.author ? { author: imp.author as string } : {}),
          createdAt: this.stamp(),
          updatedAt: this.stamp(),
        });
      }
    }
  }

  private applyRemovals(ids: string[]): { removedThreads: string[]; removedMessages: string[] } {
    const wanted = new Set(ids);
    const removedThreads: string[] = [];
    const removedMessages: string[] = [];
    this.threads = this.threads.filter((t) => {
      if (wanted.has(t.id)) {
        removedThreads.push(t.id);
        return false;
      }
      return true;
    });
    for (const t of this.threads) {
      t.messages = t.messages.filter((m) => {
        if (wanted.has(m.id)) {
          removedMessages.push(m.id);
          return false;
        }
        return true;
      });
    }
    this.threads = this.threads.filter((t) => {
      if (t.messages.length === 0) {
        removedThreads.push(t.id);
        return false;
      }
      return true;
    });
    return { removedThreads, removedMessages };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/diff') {
        send(200, { baseCommitish: 'base-resolved', targetCommitish: 'head-resolved' });
      } else if (req.method === 'GET' && url.pathname === '/api/comments-json') {
        send(200, { version: this.version, threads: this.threads });
      } else if (req.method === 'POST' && url.pathname === '/api/comment-imports') {
        const imports = (await readJson(req)) as unknown[];
        this.applyImports(imports);
        this.onImports?.(imports);
        this.version += 1;
        send(200, { imported: imports.length });
      } else if (req.method === 'POST' && url.pathname === '/api/comment-removals') {
        const { ids } = (await readJson(req)) as { ids: string[] };
        const outcome = this.applyRemovals(ids);
        this.version += 1;
        send(200, outcome);
      } else if (req.method === 'POST' && url.pathname === '/api/walkthrough') {
        send(200, { ok: true });
      } else {
        send(404, { error: `no fake route for ${req.method} ${url.pathname}` });
      }
    } catch (e) {
      send(500, { error: String(e) });
    }
  }
}

// ---------- Harness ----------

const REF = { repoPath: '/fake/repo' };
const REPO_ID = 'fakerepoid';
const TASK_HASH = computeTaskKeyHash(REPO_ID, 'feature', 'main');
const NOW = '2026-08-18T00:00:00Z';

const watchers = (
  InstanceWatcher as unknown as {
    instances: Array<{
      port: number;
      handlers: { onCommentsChanged: () => void; onReviewFinished: () => void; onDisconnect: () => void };
    }>;
  }
).instances;

let fake: FakeDifit;
let registry: Registry;
let home = '';
let prevHome: string | undefined;

function storeFor(): TaskStore {
  return new TaskStore(REPO_ID, TASK_HASH);
}

/** The current snapshot chain of the live task — awaiting it settles every
 *  queued snapshot (the watcher's, the drain's, comment remove's follow-up). */
function chain(reg: Registry): Promise<void> {
  const live = (reg as unknown as { live: Map<string, { snapshotChain: Promise<void> }> }).live;
  const task = live.get(TASK_HASH);
  if (!task) throw new Error('no live task to await');
  return task.snapshotChain;
}

/** Simulate the instance's SSE commentsChanged event and wait for the snapshot. */
async function fireCommentsChanged(reg: Registry): Promise<void> {
  const watcher = watchers.at(-1);
  if (!watcher) throw new Error('no watcher instance');
  watcher.handlers.onCommentsChanged();
  await chain(reg);
}

function agentImport(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'thread',
    id,
    author: 'agent',
    filePath: 'src/x.ts',
    position: { side: 'new', line: 10 },
    body: `finding ${id}`,
    ...over,
  };
}

function seedMeta(generation: number): void {
  storeFor().setMeta({
    schemaVersion: 1,
    repositoryId: REPO_ID,
    repoRoot: '/fake/repo',
    source: 'feature',
    base: 'main',
    taskKeyHash: TASK_HASH,
    port: fake.port,
    pid: null,
    baseSha: 'base-1',
    targetSha: 'head-1',
    status: 'stopped',
    generation,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function storedThread(id: string, generation: number, messageIds: string[]): StoredThread {
  return {
    id,
    filePath: 'src/a.ts',
    createdAt: NOW,
    updatedAt: NOW,
    position: { side: 'new', line: 3 },
    generation,
    messages: messageIds.map((mid) => ({
      id: mid,
      body: `body of ${mid}`,
      author: 'nikita',
      createdAt: NOW,
      updatedAt: NOW,
    })),
  };
}

beforeAll(async () => {
  fake = new FakeDifit();
  await fake.start();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  prevHome = process.env.REVU_HOME;
  home = mkdtempSync(join(tmpdir(), 'revu-registry-test-'));
  process.env.REVU_HOME = home;
  fake.reset();
  watchers.length = 0;
  vi.mocked(revParse).mockResolvedValue('head-1');
  vi.mocked(spawnInstance).mockClear();
  // A fresh difit instance boots with an empty comment session.
  vi.mocked(spawnInstance).mockImplementation(async () => {
    fake.reset();
    return { pid: 4242 };
  });
  registry = new Registry({ from: fake.port, to: fake.port });
});

afterEach(async () => {
  await registry.shutdown();
  if (prevHome === undefined) delete process.env.REVU_HOME;
  else process.env.REVU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

// ---------- Tests ----------

describe('staged imports and the review start baseline', () => {
  it('stages against a dead instance unbumped, bumps at drain, and reports a post-drain baseline', async () => {
    const staged = await registry.commentAdd(REF, [agentImport('a1')]);
    expect(staged.staged).toBe(true);
    expect(staged.count).toBe(1);
    expect(staged.generation).toBe(0); // current, unbumped — the bump happens at drain

    expect(storeFor().getStaging().imports).toHaveLength(1);

    const started = await registry.reviewStart(REF, {});
    expect(started.reused).toBe(false);
    // The baseline is read after the drain's snapshot settles, so it covers
    // the agent's own staged comments.
    expect(started.generation).toBe(1);

    const store = storeFor();
    expect(store.getStaging().imports).toHaveLength(0);
    expect(store.getMeta()?.generation).toBe(1);
    expect(
      store.getThreads()?.threads.map((t) => ({ id: t.id, generation: t.generation })),
    ).toEqual([{ id: 'a1', generation: 1 }]);
  });

  it('self-echoes drained staged comments into older cursors but not into the post-drain baseline', async () => {
    await registry.commentAdd(REF, [agentImport('a1')]);
    const started = await registry.reviewStart(REF, {});

    // Accepted rough edge: a consumer holding a pre-drain cursor sees the
    // agent's own staged batch in its delta.
    const echoed = await registry.commentGet(REF, 0);
    expect((echoed.threads as StoredThread[]).map((t) => t.id)).toEqual(['a1']);
    expect(echoed.generation).toBe(1);

    // For the staging agent itself the wart heals: the baseline returned by
    // review start already covers the drained batch.
    const fromBaseline = await registry.commentGet(REF, started.generation);
    expect(fromBaseline.threads).toEqual([]);
    expect(fromBaseline.resolved).toEqual([]);
    expect(fromBaseline.generation).toBe(1);
  });
});

describe('restart re-injection', () => {
  it('produces no phantom bump: stamps survive the restart and the re-anchored round-trip', async () => {
    await registry.reviewStart(REF, {});
    fake.addUserThread({ id: 'u1', line: 3 });
    await fireCommentsChanged(registry);

    expect(storeFor().getMeta()?.generation).toBe(1);
    expect(storeFor().getThreads()?.threads[0]?.generation).toBe(1);

    // Branch head moved: restart on the same port with thread re-injection.
    vi.mocked(revParse).mockResolvedValue('head-2');
    const restarted = await registry.reviewStart(REF, {});
    expect(restarted.restarted).toBe(true);
    expect(restarted.generation).toBe(1); // the baseline is untouched by the restart

    // The new instance holds the re-injected thread (fresh timestamps).
    expect(fake.threads.map((t) => t.id)).toEqual(['u1']);

    // difit re-anchors and recomputes the code snapshot on the new diff; the
    // duplicate SSE snapshot must still diff empty by the projection.
    fake.threads[0]!.position = { side: 'new', line: 42 };
    fake.threads[0]!.updatedAt = 'much-later';
    fake.threads[0]!.codeSnapshot = { content: 'the code moved' };
    await fireCommentsChanged(registry);

    const store = storeFor();
    expect(store.getMeta()?.generation).toBe(1); // no phantom bump
    const after = store.getThreads()?.threads[0];
    expect(after?.generation).toBe(1); // stamp carried forward across the restart
    expect(after?.position).toEqual({ side: 'new', line: 42 }); // body itself is fresh

    const empty = await registry.commentGet(REF, 1);
    expect(empty.threads).toEqual([]);
    expect(empty.resolved).toEqual([]);
  });

  it('delivers post-restart feedback whole from the pre-restart cursor', async () => {
    await registry.reviewStart(REF, {});
    fake.addUserThread({ id: 'u1', line: 3 });
    await fireCommentsChanged(registry); // generation 1

    vi.mocked(revParse).mockResolvedValue('head-2');
    await registry.reviewStart(REF, {});

    fake.addUserReply('u1', 'ur1', 'still an issue after the fix');
    await fireCommentsChanged(registry);

    expect(storeFor().getMeta()?.generation).toBe(2);
    const delta = await registry.commentGet(REF, 1);
    const threads = delta.threads as StoredThread[];
    expect(threads.map((t) => t.id)).toEqual(['u1']);
    // The thread arrives whole: original message plus the new reply.
    expect(threads[0]?.messages.map((m) => m.id)).toEqual(['u1', 'ur1']);
    expect(delta.generation).toBe(2);
  });
});

describe('comment add on a live instance', () => {
  it('returns N+1 for the batch while a concurrent user change lands at N+2, above the cursor', async () => {
    await registry.reviewStart(REF, {});
    fake.addUserThread({ id: 'u1', line: 3 });
    await fireCommentsChanged(registry); // generation 1

    // The user replies in the very instant the agent's batch lands: both
    // changes surface in the same snapshot diff.
    fake.onImports = () => {
      fake.addUserReply('u1', 'ur1');
      fake.onImports = null;
    };
    const added = await registry.commentAdd(REF, [agentImport('a1')]);
    expect(added.staged).toBeUndefined();
    expect(added.generation).toBe(2); // the agent's cursor: its own write

    const store = storeFor();
    expect(store.getMeta()?.generation).toBe(3); // counter advanced past the foreign stamp
    const byId = new Map(store.getThreads()?.threads.map((t) => [t.id, t.generation]));
    expect(byId.get('a1')).toBe(2); // mine
    expect(byId.get('u1')).toBe(3); // foreign

    // Delta from the returned cursor: the user's concurrent reply is
    // delivered, the agent's own batch is not echoed back.
    const delta = await registry.commentGet(REF, added.generation);
    expect((delta.threads as StoredThread[]).map((t) => t.id)).toEqual(['u1']);
    expect(delta.generation).toBe(3);
  });

  it('splits attribution even when the SSE event outruns the import response (the real difit ordering)', async () => {
    await registry.reviewStart(REF, {});
    fake.addUserThread({ id: 'u1', line: 3 });
    await fireCommentsChanged(registry); // generation 1

    // Real difit broadcasts commentsChanged BEFORE it answers the import
    // POST, so the watcher's snapshot fires while commentAdd is still
    // awaiting postImports. It must chain after the batch snapshot — an
    // ordinary snapshot running first would consume the diff in one shared
    // bump and stamp the user's concurrent reply AT the returned cursor.
    fake.onImports = () => {
      fake.addUserReply('u1', 'ur1');
      watchers.at(-1)!.handlers.onCommentsChanged();
      fake.onImports = null;
    };
    const added = await registry.commentAdd(REF, [agentImport('a1')]);
    expect(added.generation).toBe(2); // the agent's cursor: its own write

    await chain(registry); // the SSE-triggered snapshot must diff empty

    const store = storeFor();
    expect(store.getMeta()?.generation).toBe(3); // no shared bump
    const byId = new Map(store.getThreads()?.threads.map((t) => [t.id, t.generation]));
    expect(byId.get('a1')).toBe(2); // mine
    expect(byId.get('u1')).toBe(3); // foreign — strictly above the cursor

    const delta = await registry.commentGet(REF, added.generation);
    expect((delta.threads as StoredThread[]).map((t) => t.id)).toEqual(['u1']);
    expect(delta.generation).toBe(3);
  });

  it('without concurrent activity the counter simply becomes N+1 and the delta is empty', async () => {
    await registry.reviewStart(REF, {});
    const added = await registry.commentAdd(REF, [agentImport('a1')]);
    expect(added.generation).toBe(1);
    expect(storeFor().getMeta()?.generation).toBe(1);

    const delta = await registry.commentGet(REF, added.generation);
    expect(delta).toMatchObject({ threads: [], resolved: [], generation: 1 });
  });
});

describe('resolution stamping', () => {
  it('moves a disappeared thread to resolved.json stamped with the snapshot generation, whole in the delta', async () => {
    await registry.reviewStart(REF, {});
    fake.addUserThread({ id: 'u1', line: 3 });
    fake.addUserReply('u1', 'r1', 'more context');
    fake.addUserThread({ id: 'u2', line: 7 });
    await fireCommentsChanged(registry); // generation 1, both threads stamped 1

    fake.removeThread('u1'); // the user resolves it in the UI
    await fireCommentsChanged(registry);

    const store = storeFor();
    expect(store.getMeta()?.generation).toBe(2);
    const resolved = store.getResolved().threads;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.generation).toBe(2); // the snapshot's bump generation
    expect(resolved[0]?.thread.id).toBe('u1');

    const delta = await registry.commentGet(REF, 1);
    expect(delta.threads).toEqual([]); // untouched u2 carries its old stamp
    const entries = delta.resolved as Array<{
      thread: StoredThread;
      resolvedAt: string;
      generation: number;
    }>;
    expect(entries.map((e) => e.thread.id)).toEqual(['u1']);
    // The resolved entry arrives whole: full thread with every message.
    expect(entries[0]?.thread.messages.map((m) => m.id)).toEqual(['u1', 'r1']);
    expect(entries[0]?.resolvedAt).toBeTruthy();
    expect(entries[0]?.generation).toBe(2);
    expect(delta.generation).toBe(2);
  });
});

describe('comment remove', () => {
  it('live: bumps once, returns the new generation, and never fakes a resolution', async () => {
    await registry.reviewStart(REF, {});
    fake.addUserThread({ id: 'u1', line: 3 });
    fake.addUserThread({ id: 'u2', line: 7 });
    await fireCommentsChanged(registry); // generation 1

    const removed = await registry.commentRemove(REF, ['u1']);
    expect(removed.removedThreads).toEqual(['u1']);
    expect(removed.generation).toBe(2);

    // The follow-up snapshot queued by commentRemove must diff empty: the
    // removal updated the store and the instance in one chain link.
    await chain(registry);

    const store = storeFor();
    expect(store.getMeta()?.generation).toBe(2); // no double bump
    expect(store.getResolved().threads).toEqual([]); // a removal is not a resolution
    expect(store.getThreads()?.threads.map((t) => t.id)).toEqual(['u2']);

    const delta = await registry.commentGet(REF, 1);
    expect(delta).toMatchObject({ threads: [], resolved: [], generation: 2 });
  });

  it('store-only: bumps per effective removal, leaves surviving stamps alone, and skips the bump on notFound', async () => {
    seedMeta(5);
    const store = storeFor();
    store.setThreads({
      schemaVersion: 1,
      version: 3,
      threads: [storedThread('t1', 2, ['t1', 'r1'])],
      capturedAt: NOW,
      headSha: 'head-1',
    });
    store.setResolved({
      schemaVersion: 1,
      threads: [{ thread: storedThread('done1', 3, ['done1']), resolvedAt: NOW, generation: 3 }],
    });

    // A message removal: the surviving thread keeps its stamp (nothing left
    // to stamp for the vanished item), the counter still bumps.
    const messageGone = await registry.commentRemove(REF, ['r1']);
    expect(messageGone.removedMessages).toEqual(['r1']);
    expect(messageGone.generation).toBe(6);
    expect(storeFor().getThreads()?.threads[0]?.generation).toBe(2);

    const resolvedGone = await registry.commentRemove(REF, ['done1']);
    expect(resolvedGone.removedResolved).toEqual(['done1']);
    expect(resolvedGone.generation).toBe(7);

    const nothing = await registry.commentRemove(REF, ['ghost']);
    expect(nothing.notFound).toEqual(['ghost']);
    expect(nothing.generation).toBe(7); // no removal, no bump
    expect(storeFor().getMeta()?.generation).toBe(7);
  });
});

describe('cursor validation', () => {
  it('review start fails fast on a cursor from a former life, before any launch', async () => {
    seedMeta(2);
    await expect(registry.reviewStart(REF, { since: 5 })).rejects.toMatchObject({
      code: 'CURSOR_INVALID',
      details: { since: 5, generation: 2 },
    });
    expect(vi.mocked(spawnInstance)).not.toHaveBeenCalled();

    // A cursor at the counter is valid, and the baseline survives the launch.
    const ok = await registry.reviewStart(REF, { since: 2 });
    expect(ok.generation).toBe(2);
    expect(vi.mocked(spawnInstance)).toHaveBeenCalledTimes(1);
  });

  it('comment get rejects an ahead cursor as CURSOR_INVALID and malformed ones as INVALID_ARGS', async () => {
    seedMeta(2);
    await expect(registry.commentGet(REF, 3)).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
    await expect(registry.commentGet(REF, -1)).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    await expect(registry.commentGet(REF, 1.5)).rejects.toMatchObject({ code: 'INVALID_ARGS' });

    // since == current generation is the normal empty delta, not an error.
    const delta = await registry.commentGet(REF, 2);
    expect(delta).toMatchObject({ threads: [], resolved: [], generation: 2 });
  });
});

describe('pre-migration state files', () => {
  it('parses files without generation fields as stamp 0: served in full reads, excluded from --since 0 deltas', async () => {
    const dir = storeFor().dir;
    mkdirSync(dir, { recursive: true });
    // Written raw, exactly as an old daemon left them — no generation anywhere.
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: 1,
        repositoryId: REPO_ID,
        repoRoot: '/fake/repo',
        source: 'feature',
        base: 'main',
        taskKeyHash: TASK_HASH,
        port: fake.port,
        pid: null,
        baseSha: 'base-1',
        targetSha: 'head-1',
        status: 'stopped',
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    const legacyThread = {
      id: 'legacy1',
      filePath: 'src/a.ts',
      createdAt: NOW,
      updatedAt: NOW,
      position: { side: 'new', line: 3 },
      messages: [{ id: 'legacy1', body: 'old finding', author: 'nikita', createdAt: NOW, updatedAt: NOW }],
    };
    writeFileSync(
      join(dir, 'threads.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 7,
        threads: [legacyThread],
        capturedAt: NOW,
        headSha: 'head-1',
      }),
    );
    writeFileSync(
      join(dir, 'resolved.json'),
      JSON.stringify({
        schemaVersion: 1,
        threads: [{ thread: { ...legacyThread, id: 'legacy2' }, resolvedAt: NOW }],
      }),
    );

    const full = await registry.commentGet(REF);
    expect(full.generation).toBe(0);
    expect((full.threads as StoredThread[]).map((t) => t.id)).toEqual(['legacy1']);
    expect((full.threads as StoredThread[])[0]?.generation).toBe(0);
    expect(full.resolved).toHaveLength(1);

    // Honest deltas: pre-migration items predate any cursor.
    const delta = await registry.commentGet(REF, 0);
    expect(delta).toMatchObject({ threads: [], resolved: [], generation: 0 });
  });
});
