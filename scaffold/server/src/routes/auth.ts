import { Router, type Response } from 'express';
import { config } from '../config.js';
import { ah, HttpError } from '../lib/http.js';
import { getRedis } from '../lib/redis.js';
import { authorizeUrl, exchangeCode, newPkce, randomToken, verifyIdToken } from '../lib/oidc.js';
import {
  createSession,
  destroySession,
  readCookie,
  sessionIdFromCookieHeader,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type Membership,
} from '../services/sessions.js';

export const authRouter = Router();

const LOGIN_COOKIE = 'sb_login'; // binds the login to this browser (CSRF on the callback)
const LOGIN_TTL_SECONDS = 600;
const pkceKey = (state: string) => `sb:pkce:${state}`;
const secure = config.oidc.redirectUri.startsWith('https://');

function setCookie(res: Response, name: string, value: string, maxAgeSeconds: number, path = '/') {
  res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure, path, maxAge: maxAgeSeconds * 1000 });
}

// 1. Start login: remember state/nonce/verifier in Redis (any copy can finish it), redirect to IdP.
authRouter.get(
  '/login',
  ah(async (_req, res) => {
    const state = randomToken(16);
    const nonce = randomToken(16);
    const { verifier, challenge } = newPkce();
    await getRedis().set(pkceKey(state), JSON.stringify({ verifier, nonce }), 'EX', LOGIN_TTL_SECONDS);
    setCookie(res, LOGIN_COOKIE, state, LOGIN_TTL_SECONDS, '/auth');
    res.redirect(302, await authorizeUrl({ state, nonce, challenge }));
  }),
);

// 2. IdP sends the browser back with ?code&state. Finish the login and set the session cookie.
authRouter.get(
  '/callback',
  ah(async (req, res) => {
    const { code, state, error } = req.query;
    if (typeof error === 'string') throw new HttpError(400, `Login failed: ${error}`);
    if (typeof code !== 'string' || typeof state !== 'string') throw new HttpError(400, 'Missing code or state');
    if (readCookie(req.headers.cookie, LOGIN_COOKIE) !== state) throw new HttpError(400, 'Login state does not match this browser');

    // GETDEL: each state can be used once (no replay of a callback URL).
    const saved = await getRedis().getdel(pkceKey(state));
    if (!saved) throw new HttpError(400, 'Login expired, please try again');
    const { verifier, nonce } = JSON.parse(saved);

    let claims: Record<string, any>;
    try {
      const tokens = await exchangeCode(code, verifier);
      claims = await verifyIdToken(tokens.id_token, nonce);
    } catch (err: any) {
      console.warn('[auth] login failed:', err?.message);
      throw new HttpError(401, 'Login could not be verified');
    }

    // Workspaces and roles come only from the signed token.
    const workspaces: Membership[] = (Array.isArray(claims.workspaces) ? claims.workspaces : [])
      .filter((w: any) => typeof w?.id === 'string' && (w.role === 'admin' || w.role === 'agent'))
      .map((w: any) => ({ id: w.id, role: w.role }));

    // New session id on every login (no session fixation); drop the old one if any.
    await destroySession(sessionIdFromCookieHeader(req.headers.cookie));
    const sid = await createSession({ sub: claims.sub, name: claims.name, email: claims.email, workspaces });

    setCookie(res, SESSION_COOKIE, sid, SESSION_TTL_SECONDS);
    res.clearCookie(LOGIN_COOKIE, { path: '/auth' });
    res.redirect(302, `${config.webOrigin}/`);
  }),
);

authRouter.post(
  '/logout',
  ah(async (req, res) => {
    await destroySession(sessionIdFromCookieHeader(req.headers.cookie));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  }),
);
