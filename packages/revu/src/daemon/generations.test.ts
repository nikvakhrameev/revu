import { describe, expect, it } from 'vitest';

import {
  filterByStamp,
  isCursorAhead,
  projectionEquals,
  stampSnapshot,
  type ProjectedThread,
} from './generations.js';

// Threads shaped like StoredThread (extra fields beyond the projection) to
// prove the diff only looks at {id, filePath, messages[].{id, body, author}}.
interface TestThread extends ProjectedThread {
  createdAt: string;
  updatedAt: string;
  position: { side: 'old' | 'new'; line: number };
  codeSnapshot?: { content: string };
  messages: Array<{ id: string; body: string; author?: string; createdAt: string }>;
}

function thread(over: Partial<TestThread> & { id: string }): TestThread {
  return {
    filePath: 'src/a.ts',
    createdAt: '2026-08-18T10:00:00Z',
    updatedAt: '2026-08-18T10:00:00Z',
    position: { side: 'new', line: 3 },
    codeSnapshot: { content: 'const x = 1;' },
    messages: [
      { id: `${over.id}-m1`, body: 'first', author: 'user', createdAt: '2026-08-18T10:00:00Z' },
    ],
    ...over,
  };
}

describe('projectionEquals', () => {
  const base = thread({ id: 't1' });

  it('ignores createdAt/updatedAt, codeSnapshot and position', () => {
    const roundTripped = {
      ...base,
      createdAt: '2026-08-18T12:00:00Z',
      updatedAt: '2026-08-18T12:34:56Z',
      position: { side: 'new' as const, line: 42 },
      codeSnapshot: { content: 'const x = 2; // code moved' },
      messages: base.messages.map((m) => ({ ...m, createdAt: '2026-08-18T12:00:00Z' })),
    };
    expect(projectionEquals(base, roundTripped)).toBe(true);
  });

  it('detects a body edit', () => {
    const edited = {
      ...base,
      messages: [{ ...base.messages[0]!, body: 'first, edited' }],
    };
    expect(projectionEquals(base, edited)).toBe(false);
  });

  it('detects a new message', () => {
    const replied = {
      ...base,
      messages: [
        ...base.messages,
        { id: 'r1', body: 'a reply', author: 'user', createdAt: '2026-08-18T11:00:00Z' },
      ],
    };
    expect(projectionEquals(base, replied)).toBe(false);
  });

  it('detects an author change and a filePath change', () => {
    expect(
      projectionEquals(base, { ...base, messages: [{ ...base.messages[0]!, author: 'agent' }] }),
    ).toBe(false);
    expect(projectionEquals(base, { ...base, filePath: 'src/b.ts' })).toBe(false);
  });
});

describe('stampSnapshot: bump-or-not by the projection', () => {
  it('does not bump when only excluded fields changed (restart re-injection)', () => {
    const prev = [{ ...thread({ id: 't1' }), generation: 3 }];
    const next = [
      {
        ...thread({ id: 't1' }),
        updatedAt: '2026-08-18T15:00:00Z',
        position: { side: 'new' as const, line: 99 },
        codeSnapshot: { content: 'shifted code' },
      },
    ];
    const out = stampSnapshot(prev, next, 5);
    expect(out.bumped).toBe(false);
    expect(out.generation).toBe(5);
    expect(out.threads[0]!.generation).toBe(3); // carried forward, no phantom delta
  });

  it('bumps once, shared by all changes, on an ordinary snapshot', () => {
    const prev = [
      { ...thread({ id: 't1' }), generation: 2 },
      { ...thread({ id: 't2' }), generation: 4 },
    ];
    const next = [
      {
        ...prev[0]!,
        messages: [...prev[0]!.messages, { id: 'r1', body: 'reply', author: 'user', createdAt: 'x' }],
      },
      prev[1]!,
      thread({ id: 't3' }),
    ];
    const out = stampSnapshot(prev, next, 7);
    expect(out.bumped).toBe(true);
    expect(out.generation).toBe(8);
    expect(out.threads.map((t) => t.generation)).toEqual([8, 4, 8]);
  });

  it('empty diff on the duplicate post-import snapshot does not bump', () => {
    const prev = [{ ...thread({ id: 't1' }), generation: 6 }];
    const out = stampSnapshot(prev, [thread({ id: 't1' })], 6);
    expect(out.bumped).toBe(false);
    expect(out.generation).toBe(6);
    expect(out.batchGeneration).toBe(6);
  });

  it('a disappearance alone bumps and stamps the resolution generation', () => {
    const prev = [
      { ...thread({ id: 't1' }), generation: 2 },
      { ...thread({ id: 't2' }), generation: 2 },
    ];
    const out = stampSnapshot(prev, [thread({ id: 't1' })], 4);
    expect(out.bumped).toBe(true);
    expect(out.generation).toBe(5);
    expect(out.resolvedStamp).toBe(5);
    expect(out.threads[0]!.generation).toBe(2); // survivor unchanged
  });

  it('carries stamps across consecutive snapshots', () => {
    const gen1 = stampSnapshot([], [thread({ id: 't1' })], 0);
    expect(gen1.threads[0]!.generation).toBe(1);
    const gen2 = stampSnapshot(gen1.threads, [...gen1.threads, thread({ id: 't2' })], 1);
    expect(gen2.generation).toBe(2);
    expect(gen2.threads.map((t) => t.generation)).toEqual([1, 2]);
  });
});

describe('stampSnapshot: batch attribution', () => {
  it('stamps a pure agent batch N+1 and advances the counter to N+1', () => {
    const agentThread = {
      ...thread({ id: 'a1' }),
      messages: [{ id: 'a1', body: 'agent finding', author: 'agent', createdAt: 'x' }],
    };
    const out = stampSnapshot([], [agentThread], 4, new Set(['a1']));
    expect(out.bumped).toBe(true);
    expect(out.batchGeneration).toBe(5); // what comment add returns
    expect(out.generation).toBe(5); // no foreign group -> counter is N+1
    expect(out.threads[0]!.generation).toBe(5);
  });

  it('splits batch (N+1) from a concurrent foreign change (N+2)', () => {
    const userThread = { ...thread({ id: 'u1' }), generation: 3 };
    const agentThread = {
      ...thread({ id: 'a1' }),
      messages: [{ id: 'a1', body: 'agent finding', author: 'agent', createdAt: 'x' }],
    };
    // In the same diff: the agent's new thread AND a concurrent user reply.
    const userReplied = {
      ...userThread,
      messages: [...userThread.messages, { id: 'ur1', body: 'user reply', author: 'user', createdAt: 'x' }],
    };
    const out = stampSnapshot([userThread], [userReplied, agentThread], 4, new Set(['a1']));
    expect(out.batchGeneration).toBe(5); // agent's cursor: its own write
    expect(out.generation).toBe(6); // counter advances past the highest stamp
    const byId = new Map(out.threads.map((t) => [t.id, t.generation]));
    expect(byId.get('a1')).toBe(5); // mine: at the cursor, never re-delivered
    expect(byId.get('u1')).toBe(6); // foreign: above the cursor, next delta
  });

  it('an agent reply to an existing thread is "mine" when fully explained', () => {
    const prev = [{ ...thread({ id: 't1' }), generation: 2 }];
    const next = [
      {
        ...prev[0]!,
        messages: [...prev[0]!.messages, { id: 'ar1', body: 'agent reply', author: 'agent', createdAt: 'x' }],
      },
    ];
    const out = stampSnapshot(prev, next, 4, new Set(['ar1']));
    expect(out.threads[0]!.generation).toBe(5);
    expect(out.generation).toBe(5);
  });

  it('a thread with batch and non-batch additions mixed is foreign (not fully explained)', () => {
    const prev = [{ ...thread({ id: 't1' }), generation: 2 }];
    const next = [
      {
        ...prev[0]!,
        messages: [
          ...prev[0]!.messages,
          { id: 'ar1', body: 'agent reply', author: 'agent', createdAt: 'x' },
          { id: 'ur1', body: 'user reply', author: 'user', createdAt: 'x' },
        ],
      },
    ];
    const out = stampSnapshot(prev, next, 4, new Set(['ar1']));
    expect(out.threads[0]!.generation).toBe(6); // must stay above the returned cursor
    expect(out.batchGeneration).toBe(5);
    expect(out.generation).toBe(6);
  });

  it('a disappearance during a batch is foreign: resolved entries land at N+2', () => {
    const prev = [{ ...thread({ id: 'gone' }), generation: 1 }];
    const agentThread = {
      ...thread({ id: 'a1' }),
      messages: [{ id: 'a1', body: 'agent finding', author: 'agent', createdAt: 'x' }],
    };
    const out = stampSnapshot(prev, [agentThread], 4, new Set(['a1']));
    expect(out.batchGeneration).toBe(5);
    expect(out.resolvedStamp).toBe(6);
    expect(out.generation).toBe(6);
  });
});

describe('cursor validation and delta filtering', () => {
  it('flags a cursor ahead of the counter (CURSOR_INVALID), not one at it', () => {
    expect(isCursorAhead(5, 4)).toBe(true); // state wiped / task recreated
    expect(isCursorAhead(4, 4)).toBe(false); // empty delta, normal
    expect(isCursorAhead(0, 0)).toBe(false);
  });

  it('filters threads and resolved entries by stamp > since', () => {
    const threads = [
      { id: 't1', generation: 2 },
      { id: 't2', generation: 5 },
    ];
    const resolved = [
      { thread: { id: 'r1' }, resolvedAt: 'x', generation: 3 },
      { thread: { id: 'r2' }, resolvedAt: 'x', generation: 6 },
    ];
    expect(filterByStamp(threads, 4).map((t) => t.id)).toEqual(['t2']);
    expect(filterByStamp(resolved, 4).map((r) => r.thread.id)).toEqual(['r2']);
  });

  it('--since 0 excludes pre-migration (stamp 0 / unstamped) items', () => {
    const items = [{ id: 'old' }, { id: 'legacy', generation: 0 }, { id: 'new', generation: 1 }];
    expect(filterByStamp(items, 0).map((t) => t.id)).toEqual(['new']);
  });

  it('yields the empty delta when nothing is newer than the cursor', () => {
    const threads = [{ id: 't1', generation: 3 }];
    const resolved = [{ thread: { id: 'r1' }, generation: 2 }];
    const delta = {
      threads: filterByStamp(threads, 3),
      resolved: filterByStamp(resolved, 3),
      generation: 3,
    };
    expect(delta).toEqual({ threads: [], resolved: [], generation: 3 });
  });
});
