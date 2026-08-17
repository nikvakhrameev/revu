import { spawn } from 'child_process';
import { createRequire } from 'module';
import { connect } from 'net';
import { dirname, join } from 'path';

// Spawning and probing managed difit instances.

const require = createRequire(import.meta.url);

export function difitCliPath(): string {
  const pkgJson = require.resolve('difit/package.json');
  return join(dirname(pkgJson), 'dist', 'cli', 'index.js');
}

export interface InstanceInfo {
  repositoryId: string;
  base: string;
  target: string;
  baseMode: string;
  startedBy: string;
  taskKey?: string;
  pid?: number;
}

export async function isPortListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

export async function getInstanceInfo(port: number): Promise<InstanceInfo | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/instance-info`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as InstanceInfo;
  } catch {
    return null;
  }
}

/** True when the process listening on `port` is our managed instance for `taskKeyHash`. */
export async function isOurInstance(port: number, taskKeyHash: string): Promise<InstanceInfo | null> {
  const info = await getInstanceInfo(port);
  if (info && info.startedBy === 'wrapper' && info.taskKey === taskKeyHash) return info;
  return null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface SpawnInstanceOptions {
  repoRoot: string;
  targetSha: string;
  baseSha: string;
  port: number;
  taskKeyHash: string;
  open?: boolean;
}

export async function spawnInstance(opts: SpawnInstanceOptions): Promise<{ pid: number }> {
  const args = [
    difitCliPath(),
    opts.targetSha,
    opts.baseSha,
    '--managed',
    '--task-key',
    opts.taskKeyHash,
    '--keep-alive',
    '--port',
    String(opts.port),
  ];
  if (!opts.open) args.push('--no-open');

  const child = spawn(process.execPath, args, {
    cwd: opts.repoRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error('Failed to spawn difit instance (no pid)');

  // Readiness: wait until instance-info answers with our task key.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      throw new Error(
        `difit instance died during startup (port ${opts.port} possibly taken by another process)`,
      );
    }
    const info = await isOurInstance(opts.port, opts.taskKeyHash);
    if (info) return { pid };
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`difit instance on port ${opts.port} did not become ready in 15s`);
}

export async function killInstance(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}
