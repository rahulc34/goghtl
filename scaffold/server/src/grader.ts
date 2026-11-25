import { Router, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { db, C } from './db.js';
import { getRedis } from './redis.js';
import { ah, HttpError } from './http.js';

// 1.1 Every /__grader route needs x-grader-token == GRADER_TOKEN, else 401.
const requireGraderToken: RequestHandler = (req, _res, next) => {
  const given = Buffer.from(String(req.get('x-grader-token') ?? ''));
  const want = Buffer.from(config.graderToken);
  // timingSafeEqual: comparing time does not leak how much of the token was right
  const ok = given.length === want.length && timingSafeEqual(given, want);
  next(ok ? undefined : new HttpError(401, 'Bad grader token'));
};

export const graderRouter = Router();
graderRouter.use(requireGraderToken);

// 1.2 Delete all application data. Login sessions (sb:sess:*) may stay.
graderRouter.post(
  '/reset',
  ah(async (_req, res) => {
    const d = db();
    await Promise.all(Object.values(C).map((name) => d.collection(name).deleteMany({})));

    const redis = getRedis();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'sb:*', 'COUNT', 500);
      cursor = next;
      const toDelete = keys.filter((k) => !k.startsWith('sb:sess:'));
      if (toDelete.length) await redis.del(...toDelete);
    } while (cursor !== '0');

    res.json({ ok: true });
  }),
);

// 1.3 What the system currently believes, in the shape the brief defines.
graderRouter.get(
  '/snapshot',
  ah(async (_req, res) => {
    const d = db();
    type Ws = { contacts: Record<string, { inbound: string[]; assignee: string | null }>; outbound: Record<string, string> };
    const workspaces: Record<string, Ws> = {};
    const ws = (id: string) => (workspaces[id] ??= { contacts: {}, outbound: {} });
    const contact = (w: string, c: string) => (ws(w).contacts[c] ??= { inbound: [], assignee: null });

    for (const conv of await d.collection(C.conversations).find({}, { projection: { workspace: 1, contact: 1, assignee: 1 } }).toArray()) {
      contact(conv.workspace, conv.contact).assignee = conv.assignee ?? null;
    }

    // Same order as the UI: oldest first by Pigeon's occurred_at (tie-break on id).
    const inbound = d
      .collection(C.messages)
      .find({ direction: 'in' }, { projection: { workspace: 1, contact: 1, providerMessageId: 1 } })
      .sort({ occurredAt: 1, providerMessageId: 1 });
    for await (const m of inbound) contact(m.workspace, m.contact).inbound.push(m.providerMessageId);

    const outbound = d.collection(C.messages).find({ direction: 'out' }, { projection: { workspace: 1, clientRef: 1, status: 1 } });
    for await (const m of outbound) ws(m.workspace).outbound[m.clientRef] = m.status;

    res.json({ workspaces });
  }),
);
