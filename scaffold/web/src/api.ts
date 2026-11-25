// Small typed client for the server API. Cookies (the session) are sent automatically.

export type Membership = { id: string; role: 'admin' | 'agent' };
export type Me = { sub: string; name?: string; email?: string; workspaces: Membership[] };
export type Conversation = { contact: string; assignee: string | null; state: 'open' | 'closed'; lastActivityAt: string };
export type Status = 'queued' | 'sent' | 'delivered' | 'failed';
export type Message =
  | { direction: 'in'; text: string; at: string; message_id: string }
  | { direction: 'out'; text: string; at: string; client_ref: string; status: Status; author: string | null };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const q = (workspace: string) => `workspace=${encodeURIComponent(workspace)}`;
const conv = (contact: string) => `/api/conversations/${encodeURIComponent(contact)}`;

export const api = {
  me: () => call<Me>('/api/me'),
  logout: () => fetch('/auth/logout', { method: 'POST' }),

  conversations: (workspace: string, state: 'open' | 'closed' | 'all', cursor?: string | null) =>
    call<{ conversations: Conversation[]; nextCursor: string | null }>(
      `/api/conversations?${q(workspace)}${state === 'all' ? '' : `&state=${state}`}${cursor ? `&cursor=${cursor}` : ''}`,
    ),

  conversation: (workspace: string, contact: string) => call<Conversation>(`${conv(contact)}?${q(workspace)}`),

  messages: (workspace: string, contact: string) => call<{ messages: Message[] }>(`${conv(contact)}/messages?${q(workspace)}`),

  // client_ref is created once per message by the caller, so retrying this is safe.
  reply: (workspace: string, contact: string, text: string, client_ref: string) =>
    call(`${conv(contact)}/reply?${q(workspace)}`, { method: 'POST', body: JSON.stringify({ text, client_ref }) }),

  action: (workspace: string, contact: string, action: 'claim' | 'release' | 'close' | 'reopen') =>
    call<{ ok: boolean; assignee?: string | null }>(`${conv(contact)}/${action}?${q(workspace)}`, { method: 'POST' }),
};
