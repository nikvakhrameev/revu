import { describe, expect, it } from 'vitest';

import {
  applyStoreRemovals,
  collectThreadAnchors,
  enrichCommentImports,
  validateCommentImports,
  type CommentResolverContext,
  type Side,
} from './comments.js';

// Files are given as raw blob text; `git show` output normally ends with a
// trailing newline, so splitting yields a final '' element - exactly what the
// real context returns.
function makeCtx(files: { new?: Record<string, string>; old?: Record<string, string> }): CommentResolverContext {
  const lines = (filePath: string, side: Side): string[] | null => {
    const content = files[side]?.[filePath];
    return content === undefined ? null : content.split('\n');
  };
  return {
    getLines: lines,
    getLineCount: (filePath, side) => {
      const blobLines = lines(filePath, side);
      if (blobLines === null) return null;
      return blobLines.length > 0 && blobLines[blobLines.length - 1] === ''
        ? blobLines.length - 1
        : blobLines.length;
    },
  };
}

const ctx = makeCtx({
  new: { 'src/a.ts': 'one\ntwo\nthree\nfour\n', 'src/no-eol.ts': 'x\ny' },
  old: { 'src/a.ts': 'old-one\nold-two\n' },
});

function thread(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'thread',
    id: 't1',
    author: 'agent',
    filePath: 'src/a.ts',
    position: { side: 'new', line: 2 },
    body: 'looks wrong',
    ...over,
  };
}

function reply(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'reply',
    id: 'r1',
    author: 'agent',
    filePath: 'src/a.ts',
    position: { side: 'new', line: 2 },
    body: 'and also this',
    ...over,
  };
}

const codes = (errors: { code: string }[]): string[] => errors.map((e) => e.code);

describe('validateCommentImports', () => {
  it('accepts a thread plus a reply to it in the same batch', async () => {
    const result = await validateCommentImports([thread(), reply()], ctx, []);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('accepts a range anchor within the file', async () => {
    const result = await validateCommentImports(
      [thread({ position: { side: 'new', line: { start: 2, end: 4 } } })],
      ctx,
      [],
    );
    expect(result.ok).toBe(true);
  });

  it('resolves side "old" against the base revision', async () => {
    const ok = await validateCommentImports(
      [thread({ position: { side: 'old', line: 2 } })],
      ctx,
      [],
    );
    expect(ok.ok).toBe(true);
    const bad = await validateCommentImports(
      [thread({ position: { side: 'old', line: 4 } })],
      ctx,
      [],
    );
    expect(codes(bad.errors)).toEqual(['ANCHOR_LINES_OUT_OF_RANGE']);
  });

  it('reports a missing file', async () => {
    const result = await validateCommentImports([thread({ filePath: 'src/typo.ts' })], ctx, []);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        code: 'ANCHOR_FILE_NOT_FOUND',
        path: 'imports[0]',
        message: 'file "src/typo.ts" not found on the new side',
      },
    ]);
  });

  it('reports lines past the end of the file', async () => {
    const result = await validateCommentImports(
      [thread({ position: { side: 'new', line: { start: 3, end: 9 } } })],
      ctx,
      [],
    );
    expect(result.errors).toEqual([
      {
        code: 'ANCHOR_LINES_OUT_OF_RANGE',
        path: 'imports[0]',
        message: 'lines 3-9 exceed file length 4 of "src/a.ts"',
      },
    ]);
  });

  it('counts a file without a trailing newline correctly', async () => {
    const ok = await validateCommentImports([thread({ filePath: 'src/no-eol.ts' })], ctx, []);
    expect(ok.ok).toBe(true);
    const bad = await validateCommentImports(
      [thread({ filePath: 'src/no-eol.ts', position: { side: 'new', line: 3 } })],
      ctx,
      [],
    );
    expect(codes(bad.errors)).toEqual(['ANCHOR_LINES_OUT_OF_RANGE']);
  });

  it('rejects a non-object import', async () => {
    const result = await validateCommentImports(['nope'], ctx, []);
    expect(result.errors).toEqual([
      { code: 'IMPORT_INVALID', path: 'imports[0]', message: 'import must be a JSON object' },
    ]);
  });

  it('rejects broken structure with IMPORT_INVALID', async () => {
    const cases: Record<string, unknown>[] = [
      thread({ type: 'note' }),
      thread({ filePath: '  ' }),
      thread({ filePath: 42 }),
      thread({ body: '' }),
      thread({ position: 'line 2' }),
      thread({ position: { side: 'both', line: 2 } }),
      thread({ position: { side: 'new', line: 0 } }),
      thread({ position: { side: 'new', line: 1.5 } }),
      thread({ position: { side: 'new', line: { start: 4, end: 2 } } }),
      thread({ position: { side: 'new', line: { start: 1 } } }),
    ];
    for (const entry of cases) {
      const result = await validateCommentImports([entry], ctx, []);
      expect(result.ok, JSON.stringify(entry)).toBe(false);
      expect(codes(result.errors), JSON.stringify(entry)).toContain('IMPORT_INVALID');
    }
  });

  it('does not run anchor checks when the anchor cannot be parsed', async () => {
    const result = await validateCommentImports(
      [thread({ filePath: 'src/typo.ts', position: { side: 'sideways', line: 2 } })],
      ctx,
      [],
    );
    expect(codes(result.errors)).toEqual(['IMPORT_INVALID']);
  });

  it('requires id and author', async () => {
    const result = await validateCommentImports([thread({ id: '', author: '   ' })], ctx, []);
    expect(codes(result.errors)).toEqual(['IMPORT_ID_MISSING', 'IMPORT_AUTHOR_MISSING']);

    const missing = await validateCommentImports(
      [{ type: 'thread', filePath: 'src/a.ts', position: { side: 'new', line: 1 }, body: 'x' }],
      ctx,
      [],
    );
    expect(codes(missing.errors)).toEqual(['IMPORT_ID_MISSING', 'IMPORT_AUTHOR_MISSING']);
  });

  it('rejects a reply that targets no thread', async () => {
    const result = await validateCommentImports([reply({ position: { side: 'new', line: 3 } })], ctx, []);
    expect(result.errors).toEqual([
      {
        code: 'REPLY_THREAD_NOT_FOUND',
        path: 'imports[0]',
        message: 'no thread to reply to at "src/a.ts" lines 3-3 on the new side',
      },
    ]);
  });

  it('rejects a reply whose side or file differs from the thread', async () => {
    const otherSide = await validateCommentImports(
      [thread(), reply({ position: { side: 'old', line: 2 } })],
      ctx,
      [],
    );
    expect(codes(otherSide.errors)).toEqual(['REPLY_THREAD_NOT_FOUND']);

    const otherFile = await validateCommentImports(
      [thread(), reply({ filePath: 'src/no-eol.ts', position: { side: 'new', line: 2 } })],
      ctx,
      [],
    );
    expect(codes(otherFile.errors)).toEqual(['REPLY_THREAD_NOT_FOUND']);
  });

  it('rejects a reply that precedes its thread in the batch', async () => {
    const result = await validateCommentImports([reply(), thread()], ctx, []);
    expect(codes(result.errors)).toEqual(['REPLY_THREAD_NOT_FOUND']);
    expect(result.errors[0]?.path).toBe('imports[0]');
  });

  it('matches a reply against an existing thread anchor', async () => {
    const existing = collectThreadAnchors([
      { id: 'x', filePath: 'src/a.ts', position: { side: 'new', line: { start: 2, end: 2 } } },
    ]);
    const result = await validateCommentImports([reply()], ctx, existing);
    expect(result.ok).toBe(true);
  });

  it('treats line: N and {start: N, end: N} as the same anchor', async () => {
    const fromRange = await validateCommentImports(
      [thread({ position: { side: 'new', line: { start: 2, end: 2 } } }), reply()],
      ctx,
      [],
    );
    expect(fromRange.ok).toBe(true);

    const fromScalar = await validateCommentImports(
      [thread(), reply({ position: { side: 'new', line: { start: 2, end: 2 } } })],
      ctx,
      [],
    );
    expect(fromScalar.ok).toBe(true);
  });

  it('reports the anchor of a reply before its target, one error per import', async () => {
    const result = await validateCommentImports(
      [
        thread({ position: { side: 'new', line: 9 } }),
        reply({ position: { side: 'new', line: 9 } }),
      ],
      ctx,
      [],
    );
    expect(codes(result.errors)).toEqual([
      'ANCHOR_LINES_OUT_OF_RANGE',
      'ANCHOR_LINES_OUT_OF_RANGE',
    ]);
    expect(result.errors.map((e) => e.path)).toEqual(['imports[0]', 'imports[1]']);
  });

  it('collects errors from the whole batch with per-import paths', async () => {
    const result = await validateCommentImports(
      [thread(), thread({ id: 't2', filePath: 'src/gone.ts' }), reply({ id: '' })],
      ctx,
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      {
        code: 'ANCHOR_FILE_NOT_FOUND',
        path: 'imports[1]',
        message: 'file "src/gone.ts" not found on the new side',
      },
      {
        code: 'IMPORT_ID_MISSING',
        path: 'imports[2]',
        message: 'id must be a non-empty string (agent comments are identified by it)',
      },
    ]);
  });

  it('accepts an empty batch', async () => {
    expect(await validateCommentImports([], ctx, [])).toEqual({ ok: true, errors: [] });
  });
});

describe('collectThreadAnchors', () => {
  it('takes stored threads and staged thread imports, skipping replies and junk', () => {
    const anchors = collectThreadAnchors([
      // persisted thread (no `type` field)
      { id: 'p1', filePath: 'src/a.ts', position: { side: 'new', line: 2 }, messages: [] },
      // staged imports
      { type: 'thread', id: 's1', filePath: 'src/b.ts', position: { side: 'old', line: { start: 3, end: 5 } } },
      { type: 'reply', id: 's2', filePath: 'src/c.ts', position: { side: 'new', line: 1 } },
      { type: 'thread', id: 's3', filePath: '', position: { side: 'new', line: 1 } },
      { type: 'thread', id: 's4', filePath: 'src/d.ts', position: { side: 'new', line: 0 } },
      'garbage',
      null,
    ]);
    expect(anchors).toEqual([
      { filePath: 'src/a.ts', side: 'new', lines: { start: 2, end: 2 } },
      { filePath: 'src/b.ts', side: 'old', lines: { start: 3, end: 5 } },
    ]);
  });
});

describe('enrichCommentImports', () => {
  it('cuts the anchored lines out of the blob', async () => {
    const [enriched] = (await enrichCommentImports(
      [thread({ position: { side: 'new', line: { start: 2, end: 3 } } })],
      ctx,
    )) as Record<string, unknown>[];
    expect(enriched?.codeSnapshot).toEqual({ content: 'two\nthree' });
  });

  it('cuts a single line', async () => {
    const [enriched] = (await enrichCommentImports([thread()], ctx)) as Record<string, unknown>[];
    expect(enriched?.codeSnapshot).toEqual({ content: 'two' });
  });

  it('does not pick up the trailing empty element on the last line', async () => {
    const [enriched] = (await enrichCommentImports(
      [thread({ position: { side: 'new', line: 4 } })],
      ctx,
    )) as Record<string, unknown>[];
    expect(enriched?.codeSnapshot).toEqual({ content: 'four' });
  });

  it('handles a blob without a trailing newline', async () => {
    const [enriched] = (await enrichCommentImports(
      [thread({ filePath: 'src/no-eol.ts', position: { side: 'new', line: { start: 1, end: 2 } } })],
      ctx,
    )) as Record<string, unknown>[];
    expect(enriched?.codeSnapshot).toEqual({ content: 'x\ny' });
  });

  it('reads side "old" from the base revision', async () => {
    const [enriched] = (await enrichCommentImports(
      [thread({ position: { side: 'old', line: 1 } })],
      ctx,
    )) as Record<string, unknown>[];
    expect(enriched?.codeSnapshot).toEqual({ content: 'old-one' });
  });

  it('keeps an existing snapshot and leaves replies alone', async () => {
    const given = [
      thread({ codeSnapshot: { content: 'mine', language: 'ts' } }),
      reply(),
    ];
    const enriched = (await enrichCommentImports(given, ctx)) as Record<string, unknown>[];
    expect(enriched[0]?.codeSnapshot).toEqual({ content: 'mine', language: 'ts' });
    expect(enriched[1]).not.toHaveProperty('codeSnapshot');
  });

  it('does not mutate the input imports', async () => {
    const original = thread();
    await enrichCommentImports([original], ctx);
    expect(original).not.toHaveProperty('codeSnapshot');
  });

  it('passes unresolvable entries through untouched', async () => {
    const entries = [thread({ filePath: 'src/gone.ts' }), 'garbage'];
    const enriched = await enrichCommentImports(entries, ctx);
    expect(enriched[0]).not.toHaveProperty('codeSnapshot');
    expect(enriched[1]).toBe('garbage');
  });
});

describe('applyStoreRemovals', () => {
  interface TestThread {
    id: string;
    filePath: string;
    messages: Array<{ id: string; body: string }>;
  }

  const storeThread = (id: string, messageIds: string[]): TestThread => ({
    id,
    filePath: 'src/a.ts',
    messages: messageIds.map((mid) => ({ id: mid, body: `body of ${mid}` })),
  });

  const store = () => ({
    threads: [storeThread('t1', ['t1', 'r1']), storeThread('t2', ['m2'])],
    staging: [{ type: 'thread', id: 's1' }, { type: 'reply', id: 's2' }, 'garbage'],
    resolved: [{ thread: storeThread('done1', ['done1']), resolvedAt: '2024-01-01T00:00:00Z' }],
  });

  it('removes a whole thread by thread id', () => {
    const result = applyStoreRemovals(store(), ['t1']);
    expect(result.removedThreads).toEqual(['t1']);
    expect(result.threads.map((t) => t.id)).toEqual(['t2']);
    expect(result.threadsChanged).toBe(true);
    expect(result.notFound).toEqual([]);
  });

  it('removes a single message and keeps the thread', () => {
    const result = applyStoreRemovals(store(), ['r1']);
    expect(result.removedMessages).toEqual(['r1']);
    expect(result.removedThreads).toEqual([]);
    expect(result.threads[0]?.messages.map((m) => m.id)).toEqual(['t1']);
  });

  it('drops a thread whose last message was removed', () => {
    const result = applyStoreRemovals(store(), ['m2']);
    expect(result.removedMessages).toEqual(['m2']);
    expect(result.removedThreads).toEqual(['t2']);
    expect(result.threads.map((t) => t.id)).toEqual(['t1']);
  });

  it('removes staged imports and archived resolved threads', () => {
    const result = applyStoreRemovals(store(), ['s2', 'done1']);
    expect(result.removedStaged).toEqual(['s2']);
    expect(result.removedResolved).toEqual(['done1']);
    expect(result.staging).toEqual([{ type: 'thread', id: 's1' }, 'garbage']);
    expect(result.resolved).toEqual([]);
    expect(result.stagingChanged).toBe(true);
    expect(result.resolvedChanged).toBe(true);
  });

  it('reports unknown ids as notFound and changes nothing', () => {
    const input = store();
    const result = applyStoreRemovals(input, ['ghost']);
    expect(result.notFound).toEqual(['ghost']);
    expect(result.threadsChanged).toBe(false);
    expect(result.stagingChanged).toBe(false);
    expect(result.resolvedChanged).toBe(false);
    expect(result.threads).toEqual(input.threads);
  });

  it('removes an id from every place it matches', () => {
    const input = store();
    input.resolved.push({ thread: storeThread('t1', ['t1']), resolvedAt: '2024-01-02T00:00:00Z' });
    const result = applyStoreRemovals(input, ['t1']);
    expect(result.removedThreads).toEqual(['t1']);
    expect(result.removedResolved).toEqual(['t1']);
    expect(result.notFound).toEqual([]);
  });

  it('deduplicates ids and is idempotent', () => {
    const first = applyStoreRemovals(store(), ['t1', 't1']);
    expect(first.removedThreads).toEqual(['t1']);
    const second = applyStoreRemovals(
      { threads: first.threads, staging: first.staging, resolved: first.resolved },
      ['t1'],
    );
    expect(second.removedThreads).toEqual([]);
    expect(second.notFound).toEqual(['t1']);
  });

  it('does not mutate the input threads', () => {
    const input = store();
    applyStoreRemovals(input, ['r1']);
    expect(input.threads[0]?.messages.map((m) => m.id)).toEqual(['t1', 'r1']);
  });
});
