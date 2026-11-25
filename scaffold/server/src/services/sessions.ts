import { randomBytes } from 'node:crypto';
import { getRedis } from '../lib/redis.js';

// Sessions live in Redis, so every server copy sees the same logins.
// The browser only holds a random id in an HttpOnly cookie.

export const SESSION_COOKIE = 'sb_session';
export const SESSION_TTL_SECONDS = 8 * 3600;

export type Membership = { id: string; role: 'admin' | 'agent' };
export type Session = { sub: string; name?: string; email?: string; workspaces: Membership[] };

const key = (id: string) => `sb:sess:${id}`;

export async function createSession(data: Session): Promise<string> {
  const id = randomBytes(32).toString('base64url'); // 256 bits: not guessable
  await getRedis().set(key(id), JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
  return id;
}

export async function getSession(id: string | undefined): Promise<Session | null> {
  if (!id) return null;
  const raw = await getRedis().get(key(id));
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function destroySession(id: string | undefined): Promise<void> {
  if (id) await getRedis().del(key(id));
}

// Read one cookie from a raw Cookie header (we don't need a cookie-parser dependency).
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// Used by HTTP routes and the WebSocket upgrade.
export const sessionIdFromCookieHeader = (header: string | undefined) => readCookie(header, SESSION_COOKIE);

export function roleIn(session: Session, workspace: string): Membership['role'] | null {
  return session.workspaces.find((w) => w.id === workspace)?.role ?? null;
}
