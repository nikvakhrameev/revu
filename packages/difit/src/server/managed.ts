import type { Express } from 'express';

import { validatePlanStructure, type WalkthroughPayload } from '@revu/plan-schema';

import type { DiffSelection } from '@/types/diff.js';
import type { WatchEvent } from '../types/watch.js';
import { getDiffSelectionKey } from '../utils/diffSelection.js';

// Managed-mode endpoints, mounted only when the server runs with --managed.
// Everything wrapper-specific lives here to keep upstream merge conflicts small.

export interface ManagedContext {
  repositoryId: string;
  taskKey?: string;
  startedBy: 'wrapper' | 'cli';
  getInitialSelection(): DiffSelection;
  resolveSelection(query: Record<string, unknown>): DiffSelection;
  broadcast(event: WatchEvent): void;
}

export function registerManagedRoutes(app: Express, ctx: ManagedContext): void {
  const walkthroughSessions = new Map<string, WalkthroughPayload>();

  app.get('/api/instance-info', (_req, res) => {
    const selection = ctx.getInitialSelection();
    res.json({
      repositoryId: ctx.repositoryId,
      base: selection.baseCommitish,
      target: selection.targetCommitish,
      baseMode: selection.baseMode ?? 'direct',
      startedBy: ctx.startedBy,
      taskKey: ctx.taskKey,
      pid: process.pid,
    });
  });

  app.get('/api/walkthrough', (req, res) => {
    const selection = ctx.resolveSelection(req.query as Record<string, unknown>);
    const payload = walkthroughSessions.get(getDiffSelectionKey(selection)) ?? null;
    res.json({ payload });
  });

  app.post('/api/walkthrough', (req, res) => {
    const selection = ctx.resolveSelection(req.query as Record<string, unknown>);
    const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (typeof body !== 'object' || body === null) {
      res.status(400).json({ error: 'Walkthrough payload must be a JSON object' });
      return;
    }
    const payload = body as Partial<WalkthroughPayload>;
    if (payload.schemaVersion !== 1) {
      res.status(400).json({ error: 'Unsupported walkthrough payload schemaVersion' });
      return;
    }
    const validation = validatePlanStructure(payload.plan);
    if (!validation.ok) {
      res.status(400).json({ error: 'Plan validation failed', details: validation.errors });
      return;
    }
    const stale = Array.isArray(payload.stale) ? payload.stale : [];

    walkthroughSessions.set(getDiffSelectionKey(selection), {
      schemaVersion: 1,
      plan: payload.plan as WalkthroughPayload['plan'],
      stale,
    });

    ctx.broadcast({ type: 'walkthroughChanged', timestamp: new Date().toISOString() });
    res.json({ success: true });
  });

  app.post('/api/review/finish', (_req, res) => {
    ctx.broadcast({ type: 'reviewFinished', timestamp: new Date().toISOString() });
    res.json({ success: true });
  });
}
