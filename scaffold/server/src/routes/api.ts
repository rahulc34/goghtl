import { Router, type RequestHandler } from 'express';
import { ah, HttpError } from '../lib/http.js';
import { getSession, roleIn, sessionIdFromCookieHeader, type Session } from '../services/sessions.js';
import { claim, release, setState, listConversations, listMessages } from '../services/conversations.js';
import { queueReply } from '../services/replies.js';

// The UI's API. Same services as the grader endpoints; identity always comes from the session.

export const apiRouter = Router();

// 401 without a valid session.
const requireSession: RequestHandler = ah(async (req, res, next) => {
  const session = await getSession(sessionIdFromCookieHeader(req.headers.cookie));
  if (!session) throw new HttpError(401, 'Not signed in');
  res.locals.session = session;
  next();
});

// 403 if the signed-in user is not a member of ?workspace= (or body.workspace).
const requireMember: RequestHandler = (req, res, next) => {
  const workspace = req.query.workspace ?? req.body?.workspace;
  if (typeof workspace !== 'string' || !workspace) return next(new HttpError(400, 'workspace is required'));
  if (!roleIn(res.locals.session as Session, workspace)) return next(new HttpError(403, 'Not a member of this workspace'));
  res.locals.workspace = workspace;
  next();
};

apiRouter.use(requireSession);

apiRouter.get('/me', (_req, res) => {
  const s = res.locals.session as Session;
  res.json({ sub: s.sub, name: s.name, email: s.email, workspaces: s.workspaces });
});

// Inbox: newest activity first, paginated with an opaque cursor.
apiRouter.get(
  '/conversations',
  requireMember,
  ah(async (req, res) => {
    const state = req.query.state === 'open' || req.query.state === 'closed' ? req.query.state : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    res.json(await listConversations(res.locals.workspace, { state, limit, cursor }));
  }),
);

apiRouter.get(
  '/conversations/:contact/messages',
  requireMember,
  ah(async (req, res) => {
    res.json({ messages: await listMessages(res.locals.workspace, req.params.contact) });
  }),
);

// Reply: the browser makes client_ref once per message, so a retried POST is the same reply.
apiRouter.post(
  '/conversations/:contact/reply',
  requireMember,
  ah(async (req, res) => {
    const { text, client_ref } = req.body ?? {};
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    if (typeof client_ref !== 'string' || !client_ref || client_ref.length > 100) throw new HttpError(400, 'client_ref is required');
    const s = res.locals.session as Session;
    await queueReply(res.locals.workspace, req.params.contact, text.trim(), client_ref, s.sub);
    res.status(202).json({ ok: true, client_ref });
  }),
);

// Claim / release: the agent is the signed-in user, never a value from the body.
apiRouter.post(
  '/conversations/:contact/claim',
  requireMember,
  ah(async (req, res) => {
    const r = await claim(res.locals.workspace, req.params.contact, (res.locals.session as Session).sub);
    res.status(r.ok ? 200 : 409).json(r);
  }),
);

apiRouter.post(
  '/conversations/:contact/release',
  requireMember,
  ah(async (req, res) => {
    const ok = await release(res.locals.workspace, req.params.contact, (res.locals.session as Session).sub);
    res.status(ok ? 200 : 409).json({ ok });
  }),
);

for (const [action, state] of [['close', 'closed'], ['reopen', 'open']] as const) {
  apiRouter.post(
    `/conversations/:contact/${action}`,
    requireMember,
    ah(async (req, res) => {
      const ok = await setState(res.locals.workspace, req.params.contact, state);
      if (!ok) throw new HttpError(404, 'Conversation not found');
      res.json({ ok: true, state });
    }),
  );
}
