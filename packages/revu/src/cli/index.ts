#!/usr/bin/env node
import { spawn } from 'child_process';
import { mkdirSync, openSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { Command } from 'commander';

import { daemonRequest, daemonUrl, fail, makeCliError, printResult } from './client.js';
import { revuHome } from '../daemon/store.js';
import type { ReviewStartResponse, TaskSummary } from '../shared/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TaskFlags {
  repo?: string;
  source?: string;
  base?: string;
}

function taskParams(flags: TaskFlags): { repoPath: string; source?: string; base?: string } {
  return {
    repoPath: flags.repo ? resolve(flags.repo) : process.cwd(),
    source: flags.source,
    base: flags.base,
  };
}

function withTaskOptions(cmd: Command): Command {
  return cmd
    .option('--repo <path>', 'repository path (default: current directory)')
    .option('--source <branch>', 'source branch (default: current branch)')
    .option('--base <branch>', 'base branch (default: origin/HEAD, main or master)');
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonArg(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw makeCliError('INVALID_ARGS', `${what} is not valid JSON`);
  }
}

/** --since <n>: a generation cursor — a non-negative integer. */
function parseSince(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw makeCliError('INVALID_ARGS', '--since must be a non-negative integer');
  }
  return n;
}

// ---------- daemon ----------

async function daemonStatus(): Promise<{ pid: number; liveInstances: number } | null> {
  try {
    return await daemonRequest<{ pid: number; liveInstances: number }>('GET', '/api/status', {
      timeoutMs: 2000,
    });
  } catch {
    return null;
  }
}

async function daemonUp(foreground: boolean): Promise<void> {
  const running = await daemonStatus();
  if (running) {
    printResult({ alreadyRunning: true, port: new URL(daemonUrl()).port, pid: running.pid });
    return;
  }
  const daemonMain = join(__dirname, '..', 'daemon', 'main.js');
  if (foreground) {
    await import(daemonMain);
    return;
  }
  mkdirSync(revuHome(), { recursive: true });
  const logFd = openSync(join(revuHome(), 'daemon.log'), 'a');
  const child = spawn(process.execPath, [daemonMain], {
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc'],
  });
  const handshake = await new Promise<{ port: number; pid: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Daemon did not start within 10s')), 10_000);
    child.on('message', (msg) => {
      const m = msg as { type?: string; port?: number; pid?: number };
      if (m.type === 'ready' && m.port && m.pid) {
        clearTimeout(timer);
        resolve({ port: m.port, pid: m.pid });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Daemon exited during startup (code ${code}); see ~/.revu/daemon.log`));
    });
  });
  child.disconnect();
  child.unref();
  printResult(handshake);
}

// ---------- review ----------

async function reviewWaitLoop(params: ReturnType<typeof taskParams>): Promise<void> {
  let retries = 0;
  for (;;) {
    let result: { status: 'finished' | 'pending' };
    try {
      result = await daemonRequest('GET', '/api/review/wait', {
        query: { ...params, timeoutMs: 55_000 },
        timeoutMs: 65_000,
      });
      retries = 0;
    } catch (e) {
      if (retries < 3) {
        retries++;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
    if (result.status === 'finished') return;
  }
}

const program = new Command();
program.name('revu').description('Task-oriented review wrapper around difit').version('0.1.0');

// daemon
const daemon = program.command('daemon').description('manage the revu daemon');
daemon
  .command('up')
  .description('start the daemon (detached by default)')
  .option('--foreground', 'run in the foreground (for debugging)')
  .action(async (opts: { foreground?: boolean }) => {
    await daemonUp(opts.foreground ?? false);
  });
daemon
  .command('stop')
  .description('stop the daemon (managed difit instances keep running)')
  .action(async () => {
    await daemonRequest('POST', '/api/shutdown');
    printResult({ stopped: true });
  });
daemon
  .command('status')
  .description('daemon status')
  .action(async () => {
    const status = await daemonStatus();
    if (!status) {
      throw makeCliError('DAEMON_UNREACHABLE', `No revu daemon on ${daemonUrl()}`);
    }
    printResult(status);
  });

// review
const review = program.command('review').description('review lifecycle');
withTaskOptions(
  review
    .command('run')
    .description('blocking: idempotent start + wait for Finish review + final thread snapshot'),
)
  .option('--allow-dirty', 'skip the dirty-worktree guard')
  .option('--open', 'open the browser')
  .option(
    '--since <n>',
    'generation cursor: validate fail-fast at start, return only feedback stamped above it',
    parseSince,
  )
  .action(async (opts: TaskFlags & { allowDirty?: boolean; open?: boolean; since?: number }) => {
    const params = taskParams(opts);
    const started = await daemonRequest<ReviewStartResponse>('POST', '/api/review/start', {
      body: { ...params, allowDirty: opts.allowDirty, open: opts.open, since: opts.since },
      timeoutMs: 120_000,
    });
    console.error(
      `Review ${started.reused ? 'reused' : started.restarted ? 'restarted' : 'started'} at ${started.url} — waiting for the user to press "Finish review"...`,
    );
    await reviewWaitLoop(params);
    const comments = await daemonRequest('GET', '/api/comment/get', {
      query: { ...params, since: opts.since },
    });
    printResult({ status: 'finished', ...(comments as object) });
  });
withTaskOptions(review.command('start').description('start (or reuse) the review instance'))
  .option('--allow-dirty', 'skip the dirty-worktree guard')
  .option('--open', 'open the browser')
  .action(async (opts: TaskFlags & { allowDirty?: boolean; open?: boolean }) => {
    printResult(
      await daemonRequest('POST', '/api/review/start', {
        body: { ...taskParams(opts), allowDirty: opts.allowDirty, open: opts.open },
        timeoutMs: 120_000,
      }),
    );
  });
withTaskOptions(review.command('wait').description('block until Finish review')).action(
  async (opts: TaskFlags) => {
    await reviewWaitLoop(taskParams(opts));
    printResult({ status: 'finished' });
  },
);
withTaskOptions(review.command('stop').description('snapshot threads and stop the instance')).action(
  async (opts: TaskFlags) => {
    printResult(await daemonRequest('POST', '/api/review/stop', { body: taskParams(opts) }));
  },
);
withTaskOptions(
  review.command('refresh').description('restart the instance on the current branch head'),
)
  .option('--open', 'open the browser')
  .option('--allow-dirty', 'skip the dirty-worktree guard')
  .action(async (opts: TaskFlags & { open?: boolean; allowDirty?: boolean }) => {
    printResult(
      await daemonRequest('POST', '/api/review/refresh', {
        body: { ...taskParams(opts), open: opts.open, allowDirty: opts.allowDirty },
        timeoutMs: 120_000,
      }),
    );
  });
review
  .command('list')
  .description('list known tasks (all repositories by default)')
  .option('--repo <path>', 'only tasks of this repository')
  .action(async (opts: { repo?: string }) => {
    printResult(
      await daemonRequest<{ tasks: TaskSummary[] }>('GET', '/api/review/list', {
        query: { repoPath: opts.repo ? resolve(opts.repo) : undefined },
      }),
    );
  });

// comment
const comment = program.command('comment').description('review comments');
withTaskOptions(
  comment
    .command('add')
    .description('add comments (JSON arg or stdin); staged if the instance is not running')
    .argument('[json]', 'CommentImport object or array'),
).action(async (json: string | undefined, opts: TaskFlags) => {
  const raw = json ?? (await readStdinText());
  if (!raw.trim()) throw makeCliError('INVALID_ARGS', 'No comment JSON given (arg or stdin)');
  const parsed = parseJsonArg(raw, 'comment');
  printResult(
    await daemonRequest('POST', '/api/comment/add', {
      body: { ...taskParams(opts), imports: Array.isArray(parsed) ? parsed : [parsed] },
    }),
  );
});
withTaskOptions(
  comment
    .command('remove')
    .description('remove comments by id (thread, message, staged import or resolved thread)')
    .argument('<ids...>', 'one or more comment ids'),
).action(async (ids: string[], opts: TaskFlags) => {
  printResult(
    await daemonRequest('POST', '/api/comment/remove', { body: { ...taskParams(opts), ids } }),
  );
});
withTaskOptions(
  comment.command('get').description('current + resolved threads from the daemon store'),
)
  .option(
    '--since <n>',
    'generation cursor: only threads/resolved entries stamped above it (omit for the full state)',
    parseSince,
  )
  .action(async (opts: TaskFlags & { since?: number }) => {
    printResult(
      await daemonRequest('GET', '/api/comment/get', {
        query: { ...taskParams(opts), since: opts.since },
      }),
    );
  });

// plan
const plan = program.command('plan').description('walkthrough plan');

/** Plan JSON from a file, or from stdin when the argument is "-". */
async function readPlanArg(file: string): Promise<unknown> {
  if (file === '-') {
    const raw = await readStdinText();
    if (!raw.trim()) throw makeCliError('INVALID_ARGS', 'No plan JSON on stdin');
    return parseJsonArg(raw, 'plan from stdin');
  }
  return parseJsonArg(readFileSync(file, 'utf8'), `plan file ${file}`);
}

withTaskOptions(
  plan
    .command('validate')
    .description('dry-run plan validation')
    .argument('<file | ->', 'plan JSON file, or - to read the plan from stdin'),
).action(async (file: string, opts: TaskFlags) => {
  const planJson = await readPlanArg(file);
  printResult(
    await daemonRequest('POST', '/api/plan/validate', {
      body: { ...taskParams(opts), plan: planJson },
    }),
  );
});
withTaskOptions(
  plan
    .command('set')
    .description('validate, persist, hash and push the plan to the live instance')
    .argument('<file | ->', 'plan JSON file, or - to read the plan from stdin'),
).action(async (file: string, opts: TaskFlags) => {
  const planJson = await readPlanArg(file);
  printResult(
    await daemonRequest('PUT', '/api/plan', { body: { ...taskParams(opts), plan: planJson } }),
  );
});
withTaskOptions(plan.command('get').description('stored plan with fresh stale flags')).action(
  async (opts: TaskFlags) => {
    printResult(await daemonRequest('GET', '/api/plan', { query: taskParams(opts) }));
  },
);
withTaskOptions(plan.command('check').description('stale report for the stored plan')).action(
  async (opts: TaskFlags) => {
    printResult(await daemonRequest('POST', '/api/plan/check', { body: taskParams(opts) }));
  },
);

// sync
const sync = program.command('sync').description('GitLab MR sync (requires glab)');
withTaskOptions(sync.command('pull').description('import unresolved MR discussions')).action(
  async (opts: TaskFlags) => {
    printResult(
      await daemonRequest('POST', '/api/sync/pull', { body: taskParams(opts), timeoutMs: 120_000 }),
    );
  },
);
withTaskOptions(
  sync.command('push').description('publish local threads and resolve locally-closed ones'),
).action(async (opts: TaskFlags) => {
  printResult(
    await daemonRequest('POST', '/api/sync/push', { body: taskParams(opts), timeoutMs: 120_000 }),
  );
});

program.parseAsync().catch(fail);
