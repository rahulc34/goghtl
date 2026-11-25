import express from 'express';
import { errorHandler, HttpError } from './http.js';

// Set to true when SIGTERM arrives, so the load balancer stops sending us traffic.
export const state = { shuttingDown: false };

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // Health: 200 once the server is ready (we only start listening after Mongo and Redis connect),
  // 503 while shutting down.
  app.get('/healthz', (_req, res) => {
    if (state.shuttingDown) return res.status(503).json({ ok: false });
    res.json({ ok: true });
  });

  // NOTE: the Pigeon webhook router goes HERE, before express.json(),
  // because the signature is computed over the raw body (task 2).

  app.use(express.json({ limit: '1mb' }));

  // Routes are added here as we build them (grader, api, auth).

  app.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(errorHandler);
  return app;
}
