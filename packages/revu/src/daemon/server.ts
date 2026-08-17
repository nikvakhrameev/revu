import express, { type Express, type Request, type Response } from 'express';

import { Registry, TaskError } from './registry.js';
import { GitError } from './git.js';
import { syncPull, syncPush, GlabError } from './sync.js';
import { revuError, type TaskRef } from '../shared/protocol.js';

// RPC-style HTTP API; endpoints mirror CLI commands 1:1.

function taskRefFromQuery(q: Record<string, unknown>): TaskRef {
  return {
    repoPath: typeof q.repoPath === 'string' ? q.repoPath : '',
    source: typeof q.source === 'string' ? q.source : undefined,
    base: typeof q.base === 'string' ? q.base : undefined,
  };
}

function taskRefFromBody(b: Record<string, unknown>): TaskRef {
  return {
    repoPath: typeof b.repoPath === 'string' ? b.repoPath : '',
    source: typeof b.source === 'string' ? b.source : undefined,
    base: typeof b.base === 'string' ? b.base : undefined,
  };
}

function sendError(res: Response, e: unknown): void {
  if (e instanceof TaskError) {
    const status =
      e.code === 'TASK_NOT_FOUND' || e.code === 'PLAN_NOT_FOUND'
        ? 404
        : e.code === 'INVALID_ARGS'
          ? 400
          : e.code === 'PLAN_VALIDATION_FAILED'
            ? 422
            : 409;
    res.status(status).json(revuError(e.code, e.message, e.details));
    return;
  }
  if (e instanceof GlabError) {
    res.status(502).json(revuError('GLAB_ERROR', e.message));
    return;
  }
  if (e instanceof GitError) {
    res.status(500).json(revuError('GIT_ERROR', e.message));
    return;
  }
  res
    .status(500)
    .json(revuError('INTERNAL', e instanceof Error ? e.message : 'Unknown daemon error'));
}

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((e) => sendError(res, e));
  };
}

export function createDaemonApp(registry: Registry, onShutdown: () => void): Express {
  const app = express();
  app.use(express.json({ limit: '16mb' }));

  app.get('/api/status', (_req, res) => {
    res.json({
      service: 'revu-daemon',
      pid: process.pid,
      liveInstances: registry.liveCount(),
    });
  });

  app.post(
    '/api/review/start',
    handler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const result = await registry.reviewStart(taskRefFromBody(body), {
        allowDirty: body.allowDirty === true,
        open: body.open === true,
      });
      res.json(result);
    }),
  );

  app.get(
    '/api/review/wait',
    handler(async (req, res) => {
      const timeoutMs = Math.min(
        Number.parseInt(String(req.query.timeoutMs ?? '55000'), 10) || 55_000,
        120_000,
      );
      const status = await registry.reviewWait(
        taskRefFromQuery(req.query as Record<string, unknown>),
        timeoutMs,
      );
      res.json({ status });
    }),
  );

  app.post(
    '/api/review/stop',
    handler(async (req, res) => {
      res.json(await registry.reviewStop(taskRefFromBody(req.body as Record<string, unknown>)));
    }),
  );

  app.post(
    '/api/review/refresh',
    handler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      res.json(
        await registry.reviewRefresh(taskRefFromBody(body), {
          open: body.open === true,
          allowDirty: body.allowDirty === true,
        }),
      );
    }),
  );

  app.get(
    '/api/review/list',
    handler(async (_req, res) => {
      res.json({ tasks: await registry.reviewList() });
    }),
  );

  app.post(
    '/api/comment/add',
    handler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      const imports = Array.isArray(body.imports) ? body.imports : [body.imports];
      res.json(await registry.commentAdd(taskRefFromBody(body), imports));
    }),
  );

  app.get(
    '/api/comment/get',
    handler(async (req, res) => {
      res.json(await registry.commentGet(taskRefFromQuery(req.query as Record<string, unknown>)));
    }),
  );

  app.post(
    '/api/plan/validate',
    handler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      res.json(await registry.planValidate(taskRefFromBody(body), body.plan));
    }),
  );

  app.get(
    '/api/plan',
    handler(async (req, res) => {
      res.json(await registry.planGet(taskRefFromQuery(req.query as Record<string, unknown>)));
    }),
  );

  app.put(
    '/api/plan',
    handler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      res.json(await registry.planSet(taskRefFromBody(body), body.plan));
    }),
  );

  app.post(
    '/api/plan/check',
    handler(async (req, res) => {
      res.json(await registry.planCheck(taskRefFromBody(req.body as Record<string, unknown>)));
    }),
  );

  app.post(
    '/api/sync/pull',
    handler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      res.json(await syncPull(registry, taskRefFromBody(body)));
    }),
  );

  app.post(
    '/api/sync/push',
    handler(async (req, res) => {
      const body = req.body as Record<string, unknown>;
      res.json(await syncPush(registry, taskRefFromBody(body)));
    }),
  );

  app.post('/api/shutdown', (_req, res) => {
    res.json({ ok: true });
    setTimeout(onShutdown, 50);
  });

  return app;
}
