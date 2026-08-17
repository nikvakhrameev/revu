import { loadConfig } from '../daemon/store.js';
import { DEFAULT_DAEMON_PORT, ERROR_EXIT_CODES } from '../shared/protocol.js';
import type { RevuError, RevuErrorCode } from '@revu/plan-schema';

// Thin HTTP client from CLI to daemon. Errors are printed as machine-readable
// JSON to stderr and mapped to exit codes.

export function daemonPort(): number {
  return loadConfig().daemonPort ?? DEFAULT_DAEMON_PORT;
}

export function daemonUrl(): string {
  return `http://127.0.0.1:${daemonPort()}`;
}

export class CliError extends Error {
  constructor(
    readonly payload: RevuError,
    readonly exitCode: number,
  ) {
    super(payload.error.message);
  }
}

export function makeCliError(code: RevuErrorCode, message: string, details?: unknown): CliError {
  return new CliError(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    ERROR_EXIT_CODES[code] ?? 1,
  );
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export async function daemonRequest<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = new URL(path, daemonUrl());
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch {
    throw makeCliError(
      'DAEMON_UNREACHABLE',
      `revu daemon is not reachable on ${daemonUrl()}. Ask the user to run \`revu daemon up\`.`,
    );
  }

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    if (data && typeof data === 'object' && 'error' in data) {
      const err = data as RevuError;
      throw new CliError(err, ERROR_EXIT_CODES[err.error.code] ?? 1);
    }
    throw makeCliError('INTERNAL', `Daemon returned HTTP ${res.status}`);
  }
  return data as T;
}

export function printResult(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

export function fail(e: unknown): never {
  if (e instanceof CliError) {
    console.error(JSON.stringify(e.payload));
    process.exit(e.exitCode);
  }
  console.error(
    JSON.stringify({
      error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) },
    }),
  );
  process.exit(1);
}
