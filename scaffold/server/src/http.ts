import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Throw this from any handler to answer with a specific status.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Express 4 does not catch errors from async handlers: the request would hang.
// Wrap every async handler: router.post('/x', ah(async (req, res) => { ... }))
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

// Last middleware: turns any error into a JSON answer. Never leaves a request hanging.
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let message = 'Internal error';

  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON body';
  } else if (err?.code === 11000) {
    status = 409;
    message = 'Duplicate';
  } else if (isDependencyDown(err)) {
    status = 503;
    message = 'A dependency is unavailable, retry later';
    res.set('Retry-After', '1');
  }

  if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(status).json({ error: message });
}

function isDependencyDown(err: any): boolean {
  const name: string = err?.name ?? '';
  const msg: string = err?.message ?? '';
  return (
    name.startsWith('MongoServerSelection') ||
    name.startsWith('MongoNetwork') ||
    name === 'MongoNotConnectedError' ||
    name === 'MaxRetriesPerRequestError' ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('Connection is closed')
  );
}
