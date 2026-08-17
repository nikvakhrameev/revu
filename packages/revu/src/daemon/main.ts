#!/usr/bin/env node
import { mkdirSync } from 'fs';

import { createDaemonApp } from './server.js';
import { Registry } from './registry.js';
import { loadConfig, revuHome } from './store.js';
import { DEFAULT_DAEMON_PORT } from '../shared/protocol.js';

// Daemon entry point. Singleton enforcement is the port bind itself:
// EADDRINUSE + a responding revu daemon on the port means "already running".

async function main(): Promise<void> {
  mkdirSync(revuHome(), { recursive: true });
  const config = loadConfig();
  const port = config.daemonPort ?? DEFAULT_DAEMON_PORT;

  const registry = new Registry(config.instancePorts);
  await registry.reconcile();

  const shutdown = () => {
    void registry.shutdown().finally(() => process.exit(0));
  };

  const app = createDaemonApp(registry, shutdown);

  const server = app.listen(port, '127.0.0.1', (err?: NodeJS.ErrnoException) => {
    if (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(
          JSON.stringify({
            error: {
              code: 'PORT_TAKEN',
              message: `Port ${port} is already in use (another revu daemon or a foreign process)`,
            },
          }),
        );
        process.exit(1);
      }
      console.error(JSON.stringify({ error: { code: 'INTERNAL', message: err.message } }));
      process.exit(1);
    }
    console.log(`revu daemon listening on http://127.0.0.1:${port} (pid ${process.pid})`);
    // Detached-start handshake for `revu daemon up`.
    if (process.send) {
      process.send({ type: 'ready', port, pid: process.pid });
    }
  });
  server.keepAliveTimeout = 130_000; // longer than the 120s long-poll cap

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main().catch((e) => {
  console.error(
    JSON.stringify({ error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } }),
  );
  process.exit(1);
});
