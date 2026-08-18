import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskError, type Registry } from './registry.js';
import { createDaemonApp } from './server.js';

// HTTP surface of the generations feature: the CURSOR_INVALID -> 409 mapping
// and the `since` parameter parsing on both endpoints that accept it.

const commentGet = vi.fn();
const reviewStart = vi.fn();
const registryStub = { commentGet, reviewStart } as unknown as Registry;

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = createDaemonApp(registryStub, () => {});
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  commentGet.mockReset();
  reviewStart.mockReset();
  commentGet.mockResolvedValue({
    threads: [],
    capturedAt: null,
    headSha: null,
    resolved: [],
    generation: 3,
  });
  reviewStart.mockResolvedValue({
    taskKey: 'k',
    url: 'http://localhost:7400',
    port: 7400,
    reused: false,
    restarted: false,
    baseSha: 'b',
    targetSha: 't',
    generation: 3,
  });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('CURSOR_INVALID over HTTP', () => {
  it('maps to 409 with the machine-readable error envelope on comment get', async () => {
    commentGet.mockRejectedValueOnce(
      new TaskError('CURSOR_INVALID', 'cursor ahead of the counter', { since: 9, generation: 2 }),
    );
    const res = await fetch(`${baseUrl}/api/comment/get?repoPath=%2Frepo&since=9`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'CURSOR_INVALID',
        message: 'cursor ahead of the counter',
        details: { since: 9, generation: 2 },
      },
    });
  });

  it('maps to 409 on the fail-fast review start path too', async () => {
    reviewStart.mockRejectedValueOnce(
      new TaskError('CURSOR_INVALID', 'stale cursor', { since: 5, generation: 2 }),
    );
    const res = await post('/api/review/start', { repoPath: '/repo', since: 5 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CURSOR_INVALID');
  });

  it('keeps INVALID_ARGS distinct at 400', async () => {
    commentGet.mockRejectedValueOnce(
      new TaskError('INVALID_ARGS', 'since must be a non-negative integer'),
    );
    const res = await fetch(`${baseUrl}/api/comment/get?repoPath=%2Frepo&since=-1`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_ARGS');
  });
});

describe('since parsing', () => {
  it('passes a numeric since query to the registry and omits an absent or empty one', async () => {
    await fetch(`${baseUrl}/api/comment/get?repoPath=%2Frepo&since=3`);
    expect(commentGet.mock.calls.at(-1)).toEqual([
      { repoPath: '/repo', source: undefined, base: undefined },
      3,
    ]);

    await fetch(`${baseUrl}/api/comment/get?repoPath=%2Frepo`);
    expect(commentGet.mock.calls.at(-1)?.[1]).toBeUndefined();

    await fetch(`${baseUrl}/api/comment/get?repoPath=%2Frepo&since=`);
    expect(commentGet.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it('accepts since=0 as a real cursor, not as absent', async () => {
    await fetch(`${baseUrl}/api/comment/get?repoPath=%2Frepo&since=0`);
    expect(commentGet.mock.calls.at(-1)?.[1]).toBe(0);
  });

  it('forwards a numeric body since to review start and drops a non-numeric one', async () => {
    await post('/api/review/start', { repoPath: '/repo', since: 4 });
    let opts = reviewStart.mock.calls.at(-1)?.[1] as { since?: number };
    expect(opts.since).toBe(4);

    await post('/api/review/start', { repoPath: '/repo', since: '4' });
    opts = reviewStart.mock.calls.at(-1)?.[1] as { since?: number };
    expect(opts.since).toBeUndefined();
  });
});
