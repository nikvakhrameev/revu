import type { Express } from 'express';

import { validatePlanStructure, type WalkthroughPayload } from '@revu/plan-schema';

import type { DiffCommentThread, DiffSelection } from '@/types/diff.js';
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
  getCommentThreads(selection: DiffSelection): DiffCommentThread[];
  /** Replaces the session threads; broadcasts commentsChanged when they differ. */
  setCommentThreads(selection: DiffSelection, threads: DiffCommentThread[]): void;
}

interface CommentRemovalResult {
  threads: DiffCommentThread[];
  removedThreads: string[];
  removedMessages: string[];
  notFound: string[];
  changed: boolean;
}

/** Removes whole threads by thread id and single messages by message id.
 *  A thread left without messages is dropped as well. */
function removeComments(threads: DiffCommentThread[], ids: string[]): CommentRemovalResult {
  const wanted = new Set(ids);
  const removedThreads: string[] = [];
  const removedMessages: string[] = [];
  const next: DiffCommentThread[] = [];
  let changed = false;

  for (const thread of threads) {
    if (wanted.has(thread.id)) {
      removedThreads.push(thread.id);
      changed = true;
      continue;
    }
    const kept = thread.messages.filter((message) => !wanted.has(message.id));
    if (kept.length === thread.messages.length) {
      next.push(thread);
      continue;
    }
    changed = true;
    for (const message of thread.messages) {
      if (wanted.has(message.id)) removedMessages.push(message.id);
    }
    if (kept.length === 0) {
      removedThreads.push(thread.id);
      continue;
    }
    next.push({ ...thread, messages: kept });
  }

  const removed = new Set([...removedThreads, ...removedMessages]);
  return {
    threads: next,
    removedThreads,
    removedMessages,
    notFound: ids.filter((id) => !removed.has(id)),
    changed,
  };
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

  // Wrapper-driven removal: agents delete their own comments through the daemon,
  // which forwards here so the UI (and the next snapshot) drop them too.
  app.post('/api/comment-removals', (req, res) => {
    let ids: string[];
    try {
      const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const rawIds = (body as { ids?: unknown } | null)?.ids;
      if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== 'string')) {
        res.status(400).json({ error: 'Comment removals require an "ids" array of strings' });
        return;
      }
      ids = [...new Set(rawIds as string[])];
    } catch {
      res.status(400).json({ error: 'Invalid comment removal data' });
      return;
    }

    const selection = ctx.resolveSelection(req.query as Record<string, unknown>);
    const result = removeComments(ctx.getCommentThreads(selection), ids);
    if (result.changed) {
      ctx.setCommentThreads(selection, result.threads);
    }

    res.json({
      removedThreads: result.removedThreads,
      removedMessages: result.removedMessages,
      notFound: result.notFound,
    });
  });

  app.post('/api/review/finish', (_req, res) => {
    ctx.broadcast({ type: 'reviewFinished', timestamp: new Date().toISOString() });
    res.json({ success: true });
  });
}
