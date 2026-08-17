import { execFile } from 'child_process';
import { promisify } from 'util';

import type { Registry } from './registry.js';
import { TaskError } from './registry.js';
import { loadConfig, type StoredThread } from './store.js';
import type { TaskRef } from '../shared/protocol.js';

const execFileP = promisify(execFile);

// GitLab MR sync through the `glab` binary (glab api). The daemon owns no
// tokens: authentication is entirely glab's (`glab auth login`).

export class GlabError extends Error {}

async function glab(repoRoot: string, args: string[]): Promise<string> {
  const glabPath = loadConfig().glabPath ?? 'glab';
  try {
    const { stdout } = await execFileP(glabPath, args, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const stderr =
      e instanceof Error && 'stderr' in e ? String((e as { stderr: unknown }).stderr) : String(e);
    if (stderr.includes('ENOENT') || String(e).includes('ENOENT')) {
      throw new GlabError(
        'glab binary not found. Install glab and run `glab auth login` to enable GitLab sync.',
      );
    }
    throw new GlabError(stderr.trim() || 'glab command failed');
  }
}

async function glabJson<T>(repoRoot: string, args: string[]): Promise<T> {
  return JSON.parse(await glab(repoRoot, args)) as T;
}

interface GitLabNote {
  id: number;
  body: string;
  system: boolean;
  author?: { username?: string };
  created_at: string;
  updated_at: string;
  type?: string | null;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
  resolved?: boolean;
}

interface GitLabDiscussion {
  id: string;
  individual_note: boolean;
  notes: GitLabNote[];
}

interface GitLabMr {
  iid: number;
  source_branch: string;
  target_branch: string;
  diff_refs: { base_sha: string; head_sha: string; start_sha: string };
}

async function findMr(repoRoot: string, sourceBranch: string): Promise<GitLabMr> {
  const mrs = await glabJson<GitLabMr[]>(repoRoot, [
    'api',
    `projects/:id/merge_requests?source_branch=${encodeURIComponent(sourceBranch)}&state=opened`,
  ]);
  const first = mrs[0];
  if (!first) {
    throw new GlabError(`No open GitLab MR found for source branch "${sourceBranch}"`);
  }
  return glabJson<GitLabMr>(repoRoot, ['api', `projects/:id/merge_requests/${first.iid}`]);
}

export async function syncPull(
  registry: Registry,
  ref: TaskRef,
): Promise<{ imported: number; skipped: number }> {
  const t = await registry.resolveTask(ref);
  const meta = t.store.getMeta();
  if (!meta) throw new TaskError('TASK_NOT_FOUND', 'No such task; run review start first');
  const mr = await findMr(t.repoRoot, t.source);
  const discussions = await glabJson<GitLabDiscussion[]>(t.repoRoot, [
    'api',
    '--paginate',
    `projects/:id/merge_requests/${mr.iid}/discussions?per_page=100`,
  ]);

  const sync = t.store.getSync();
  const imports: unknown[] = [];
  let skipped = 0;

  for (const d of discussions) {
    const root = d.notes[0];
    if (!root || root.system || root.type !== 'DiffNote' || !root.position) {
      skipped++;
      continue;
    }
    if (root.resolved) {
      skipped++;
      continue;
    }
    // Tombstone: locally resolved discussions are not re-imported.
    const known = sync.threads[d.id];
    if (known && (known.publishState === 'resolved-local' || known.publishState === 'resolved-synced')) {
      skipped++;
      continue;
    }
    const pos = root.position;
    const side: 'old' | 'new' = pos.new_line ? 'new' : 'old';
    const line = pos.new_line ?? pos.old_line;
    const filePath = side === 'new' ? pos.new_path : pos.old_path;
    if (!line || !filePath) {
      skipped++;
      continue;
    }
    imports.push({
      type: 'thread',
      id: d.id,
      filePath,
      position: { side, line },
      body: root.body,
      author: root.author?.username,
      createdAt: root.created_at,
      updatedAt: root.updated_at,
    });
    for (const note of d.notes.slice(1)) {
      if (note.system) continue;
      const noteId = String(note.id);
      if (sync.messageMap.some((m) => m.noteId === noteId)) continue;
      imports.push({
        type: 'reply',
        id: noteId,
        filePath,
        position: { side, line },
        body: note.body,
        author: note.author?.username,
        createdAt: note.created_at,
      });
      sync.messageMap.push({ messageId: noteId, noteId });
    }
    sync.threads[d.id] = {
      origin: 'gitlab',
      publishState: 'published',
      gitlabDiscussionId: d.id,
    };
  }

  if (imports.length > 0) {
    await registry.commentAdd(ref, imports);
  }
  t.store.setSync(sync);
  return { imported: imports.length, skipped };
}

export async function syncPush(
  registry: Registry,
  ref: TaskRef,
): Promise<{ published: number; repliesPushed: number; resolvedOnGitlab: number }> {
  const t = await registry.resolveTask(ref);
  const meta = t.store.getMeta();
  if (!meta) throw new TaskError('TASK_NOT_FOUND', 'No such task; run review start first');
  const mr = await findMr(t.repoRoot, t.source);
  const sync = t.store.getSync();
  const threadsFile = t.store.getThreads();
  const threads: StoredThread[] = threadsFile?.threads ?? [];

  let published = 0;
  let repliesPushed = 0;
  let resolvedOnGitlab = 0;

  for (const th of threads) {
    const state = sync.threads[th.id];
    const root = th.messages[0];
    if (!root) continue;

    if (!state || state.publishState === 'local-only') {
      // Publish the whole thread as a new positioned discussion.
      const line = typeof th.position.line === 'number' ? th.position.line : th.position.line.end;
      const lineArgs =
        th.position.side === 'new'
          ? [`position[new_line]=${line}`]
          : [`position[old_line]=${line}`];
      const result = await glabJson<{ id: string; notes: GitLabNote[] }>(t.repoRoot, [
        'api',
        '-X',
        'POST',
        `projects/:id/merge_requests/${mr.iid}/discussions`,
        '-f',
        `body=${root.body}`,
        '-f',
        'position[position_type]=text',
        '-f',
        `position[base_sha]=${mr.diff_refs.base_sha}`,
        '-f',
        `position[head_sha]=${mr.diff_refs.head_sha}`,
        '-f',
        `position[start_sha]=${mr.diff_refs.start_sha}`,
        '-f',
        `position[new_path]=${th.filePath}`,
        '-f',
        `position[old_path]=${th.filePath}`,
        ...lineArgs.flatMap((a) => ['-f', a]),
      ]);
      sync.threads[th.id] = {
        origin: state?.origin ?? 'local',
        publishState: 'published',
        gitlabDiscussionId: result.id,
      };
      const rootNote = result.notes[0];
      if (rootNote) sync.messageMap.push({ messageId: root.id, noteId: String(rootNote.id) });
      published++;
      // Publish replies that came with the thread.
      for (const msg of th.messages.slice(1)) {
        const note = await glabJson<GitLabNote>(t.repoRoot, [
          'api',
          '-X',
          'POST',
          `projects/:id/merge_requests/${mr.iid}/discussions/${result.id}/notes`,
          '-f',
          `body=${msg.body}`,
        ]);
        sync.messageMap.push({ messageId: msg.id, noteId: String(note.id) });
        repliesPushed++;
      }
      continue;
    }

    if (state.publishState === 'published' && state.gitlabDiscussionId) {
      // Incremental: push messages that have no GitLab note yet.
      for (const msg of th.messages) {
        if (sync.messageMap.some((m) => m.messageId === msg.id)) continue;
        const note = await glabJson<GitLabNote>(t.repoRoot, [
          'api',
          '-X',
          'POST',
          `projects/:id/merge_requests/${mr.iid}/discussions/${state.gitlabDiscussionId}/notes`,
          '-f',
          `body=${msg.body}`,
        ]);
        sync.messageMap.push({ messageId: msg.id, noteId: String(note.id) });
        repliesPushed++;
      }
    }
  }

  // Resolve on GitLab everything resolved locally.
  for (const [threadId, state] of Object.entries(sync.threads)) {
    if (state.publishState === 'resolved-local' && state.gitlabDiscussionId) {
      await glab(t.repoRoot, [
        'api',
        '-X',
        'PUT',
        `projects/:id/merge_requests/${mr.iid}/discussions/${state.gitlabDiscussionId}?resolved=true`,
      ]);
      state.publishState = 'resolved-synced';
      sync.threads[threadId] = state;
      resolvedOnGitlab++;
    }
  }

  t.store.setSync(sync);
  return { published, repliesPushed, resolvedOnGitlab };
}
