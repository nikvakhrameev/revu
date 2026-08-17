import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export class GitError extends Error {}

async function git(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', ['-C', repoPath, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const msg = e instanceof Error && 'stderr' in e ? String((e as { stderr: unknown }).stderr) : String(e);
    throw new GitError(msg.trim() || `git ${args.join(' ')} failed`);
  }
}

export async function getRepoRoot(repoPath: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim();
}

/** Same computation difit does: sha256 of the absolute git-root path. */
export function computeRepositoryId(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex');
}

export async function revParse(repoPath: string, ref: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

export async function mergeBase(repoPath: string, a: string, b: string): Promise<string> {
  return (await git(repoPath, ['merge-base', a, b])).trim();
}

export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  const out = (await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return out === 'HEAD' ? null : out; // detached HEAD -> null
}

export async function isBranch(repoPath: string, name: string): Promise<boolean> {
  try {
    await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    try {
      await git(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/${name}`]);
      return true;
    } catch {
      return false;
    }
  }
}

export async function resolveDefaultBase(repoPath: string): Promise<string> {
  try {
    const ref = (await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
    return ref.replace('refs/remotes/', '');
  } catch {
    for (const candidate of ['main', 'master']) {
      if (await isBranch(repoPath, candidate)) return candidate;
    }
    throw new GitError('Cannot resolve a default base branch (no origin/HEAD, main or master)');
  }
}

/** Dirty check including untracked files. */
export async function isWorktreeDirty(repoPath: string): Promise<boolean> {
  const out = await git(repoPath, ['status', '--porcelain']);
  return out.trim().length > 0;
}

/** Lines of a blob at revision, or null when the file does not exist there. */
export async function getBlobLines(
  repoPath: string,
  sha: string,
  filePath: string,
): Promise<string[] | null> {
  try {
    const out = await git(repoPath, ['show', `${sha}:${filePath}`]);
    return out.split('\n');
  } catch {
    return null;
  }
}

export async function fetchRefs(repoPath: string, refspecs: string[]): Promise<void> {
  await git(repoPath, ['fetch', 'origin', ...refspecs]);
}

/**
 * Snippet hash: sha256 of the exact line range of the blob at the pinned
 * revision. Byte-parity with what difit renders is by construction: both
 * sides read the same blob through the same git plumbing.
 */
export async function hashSnippet(
  repoPath: string,
  sha: string,
  filePath: string,
  lines: { start: number; end: number },
): Promise<{ hash: string } | { missing: 'file' | 'range' }> {
  const blobLines = await getBlobLines(repoPath, sha, filePath);
  if (blobLines === null) return { missing: 'file' };
  // `git show` output ends with a trailing newline -> last split element is ''.
  const effectiveLineCount =
    blobLines.length > 0 && blobLines[blobLines.length - 1] === ''
      ? blobLines.length - 1
      : blobLines.length;
  if (lines.end > effectiveLineCount) return { missing: 'range' };
  const slice = blobLines.slice(lines.start - 1, lines.end).join('\n');
  return { hash: createHash('sha256').update(slice).digest('hex') };
}

export async function getBlobLineCount(
  repoPath: string,
  sha: string,
  filePath: string,
): Promise<number | null> {
  const blobLines = await getBlobLines(repoPath, sha, filePath);
  if (blobLines === null) return null;
  return blobLines.length > 0 && blobLines[blobLines.length - 1] === ''
    ? blobLines.length - 1
    : blobLines.length;
}
