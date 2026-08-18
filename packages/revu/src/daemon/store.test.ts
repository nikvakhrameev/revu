import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filterByStamp } from './generations.js';
import { TaskStore, type TaskMeta } from './store.js';

// Migration-free schema evolution: generation fields are additive optionals
// defaulting to 0, schemaVersion stays 1. Old state files written by a
// pre-generations daemon must parse untouched and read as stamp 0.

const NOW = '2026-08-18T00:00:00Z';

let home = '';
let prevHome: string | undefined;
let store: TaskStore;

beforeEach(() => {
  prevHome = process.env.REVU_HOME;
  home = mkdtempSync(join(tmpdir(), 'revu-store-test-'));
  process.env.REVU_HOME = home;
  store = new TaskStore('repo-id', 'task-hash');
  mkdirSync(store.dir, { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.REVU_HOME;
  else process.env.REVU_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function write(name: string, data: unknown): void {
  writeFileSync(join(store.dir, name), JSON.stringify(data));
}

const legacyThread = (id: string) => ({
  id,
  filePath: 'src/a.ts',
  createdAt: NOW,
  updatedAt: NOW,
  position: { side: 'new' as const, line: 3 },
  messages: [{ id, body: 'old finding', author: 'nikita', createdAt: NOW, updatedAt: NOW }],
});

const legacyMeta = () => ({
  schemaVersion: 1 as const,
  repositoryId: 'repo-id',
  repoRoot: '/repo',
  source: 'feature',
  base: 'main',
  taskKeyHash: 'task-hash',
  port: 7400,
  pid: null,
  baseSha: 'b',
  targetSha: 't',
  status: 'stopped' as const,
  createdAt: NOW,
  updatedAt: NOW,
});

describe('pre-migration files (no generation fields)', () => {
  it('parses meta.json and defaults the counter to 0', () => {
    write('meta.json', legacyMeta());
    expect(store.getMeta()?.generation).toBe(0);
  });

  it('parses threads.json, stamps default to 0 and are excluded from a --since 0 delta', () => {
    write('threads.json', {
      schemaVersion: 1,
      version: 7,
      threads: [legacyThread('t1')],
      capturedAt: NOW,
      headSha: 'head',
    });
    const threads = store.getThreads()?.threads ?? [];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.generation).toBe(0);
    expect(filterByStamp(threads, 0)).toEqual([]);
  });

  it('parses resolved.json, entry stamps default to 0 and are excluded from a --since 0 delta', () => {
    write('resolved.json', {
      schemaVersion: 1,
      threads: [{ thread: legacyThread('done1'), resolvedAt: NOW }],
    });
    const resolved = store.getResolved().threads;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.generation).toBe(0);
    expect(filterByStamp(resolved, 0)).toEqual([]);
  });
});

describe('stamp persistence', () => {
  it('carries generation stamps through a write/read round-trip on every file', () => {
    const meta: TaskMeta = { ...legacyMeta(), status: 'stopped', generation: 5 };
    store.setMeta(meta);
    store.setThreads({
      schemaVersion: 1,
      version: 2,
      threads: [{ ...legacyThread('t1'), generation: 7 }],
      capturedAt: NOW,
      headSha: 'head',
    });
    store.setResolved({
      schemaVersion: 1,
      threads: [{ thread: { ...legacyThread('done1'), generation: 3 }, resolvedAt: NOW, generation: 4 }],
    });

    expect(store.getMeta()?.generation).toBe(5);
    expect(store.getThreads()?.threads[0]?.generation).toBe(7);
    const entry = store.getResolved().threads[0];
    expect(entry?.generation).toBe(4);
    expect(entry?.thread.generation).toBe(3);
  });

  it('rejects a negative generation loudly as a corrupt state file', () => {
    write('threads.json', {
      schemaVersion: 1,
      version: 1,
      threads: [{ ...legacyThread('t1'), generation: -1 }],
      capturedAt: NOW,
      headSha: 'head',
    });
    expect(() => store.getThreads()).toThrow(/Corrupt state file/);
  });
});
