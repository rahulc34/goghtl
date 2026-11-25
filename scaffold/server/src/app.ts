import express from 'express';
import { errorHandler, HttpError } from './lib/http.js';
import { graderRouter } from './routes/grader.js';
import { webhookRouter } from './routes/webhook.js';

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

  // Before express.json(): the webhook needs the raw body to check the signature.
  app.use('/webhooks', webhookRouter);

  app.use(express.json({ limit: '1mb' }));

  app.use('/__grader', graderRouter);
  // More routes are added here as we build them (api, auth).

  app.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(errorHandler);
  return app;
}
