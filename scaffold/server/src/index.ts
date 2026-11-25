import { createServer } from 'node:http';
import { config } from './config.js';
import { connectDb, closeDb } from './db.js';
import { connectRedis, closeRedis } from './redis.js';
import { createApp, state } from './app.js';

async function main() {
  // Connect first, then listen: /healthz only answers once we can serve traffic.
  await Promise.all([connectDb(), connectRedis()]);

  // A plain http server, so we can attach WebSockets to it later (task 5).
  const server = createServer(createApp());
  server.requestTimeout = 30_000; // never let a request hang forever
  server.keepAliveTimeout = 5_000;

  server.listen(config.port, () => {
    console.log(`[server] pid ${process.pid} listening on http://localhost:${config.port}`);
  });

  // Background workers start here later (sender worker, task 4).

  async function shutdown(signal: string) {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    console.log(`[server] ${signal}: shutting down`);

    const force = setTimeout(() => {
      console.warn('[server] forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    force.unref();

    // Stop accepting connections, let in-flight requests finish, then close stores.
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([closeDb(), closeRedis()]);
    console.log('[server] bye');
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

main().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
