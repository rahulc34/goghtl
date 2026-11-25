import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Conversation, type Me, type Message } from './api';
import { useLive, type LiveEvent } from './useLive';
import './styles.css';

type Filter = 'open' | 'closed' | 'all';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading, null = signed out
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setError(e.message)));
  }, []);

  if (error) return <Centered>Cannot reach the server: {error}</Centered>;
  if (me === undefined) return <Centered>Loading…</Centered>;
  if (me === null)
    return (
      <Centered>
        <h1>Switchboard</h1>
        <p>Shared inbox for your support team.</p>
        <a className="button primary" href="/auth/login">
          Sign in
        </a>
      </Centered>
    );
  if (!me.workspaces.length) return <Centered>You are not a member of any workspace.</Centered>;
  return <Inbox me={me} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}

function Inbox({ me }: { me: Me }) {
  const [workspace, setWorkspace] = useState(me.workspaces[0].id);
  const [filter, setFilter] = useState<Filter>('open');
  const [list, setList] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [listError, setListError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0); // bump to reload the open conversation

  const loadList = useCallback(async () => {
    try {
      const r = await api.conversations(workspace, filter);
      setList(r.conversations);
      setCursor(r.nextCursor);
      setListError('');
    } catch (e: any) {
      setListError(e.message);
    }
  }, [workspace, filter]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => setSelected(null), [workspace]);

  // Coalesce bursts of events into one reload.
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scheduleReload = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      loadList();
      setRefreshKey((k) => k + 1);
    }, 200);
  }, [loadList]);

  const onEvent = useCallback(
    (e: LiveEvent) => {
      if (e.type === 'conversation.assigned' || e.type === 'conversation.updated') {
        // Small change: patch the row in place, no reload needed.
        setList((rows) =>
          rows.map((c) =>
            c.contact === e.contact
              ? { ...c, ...(e.type === 'conversation.assigned' ? { assignee: (e.assignee as string) ?? null } : { state: e.state as Conversation['state'] }) }
              : c,
          ),
        );
        if (e.contact === selected) setRefreshKey((k) => k + 1);
        return;
      }
      scheduleReload(); // new message or status: reload list order and the open conversation
    },
    [scheduleReload, selected],
  );
  const connected = useLive(workspace, onEvent, scheduleReload);

  const loadMore = async () => {
    if (!cursor) return;
    const r = await api.conversations(workspace, filter, cursor);
    setList((rows) => [...rows, ...r.conversations]);
    setCursor(r.nextCursor);
  };

  const role = me.workspaces.find((w) => w.id === workspace)?.role;

  return (
    <div className="app">
      <header>
        <strong>Switchboard</strong>
        <select value={workspace} onChange={(e) => setWorkspace(e.target.value)} aria-label="Workspace">
          {me.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id} ({w.role})
            </option>
          ))}
        </select>
        <span className={connected ? 'dot on' : 'dot'} title={connected ? 'Live' : 'Reconnecting…'} />
        <span className="muted">{connected ? 'Live' : 'Reconnecting…'}</span>
        <span className="spacer" />
        <span className="muted">
          {me.name ?? me.sub} · {role}
        </span>
        <button onClick={() => api.logout().then(() => location.reload())}>Sign out</button>
      </header>

      <aside>
        <div className="tabs">
          {(['open', 'closed', 'all'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
        {listError && <p className="error">{listError}</p>}
        {list.length === 0 && !listError && <p className="muted pad">No conversations.</p>}
        <ul className="list">
          {list.map((c) => (
            <li key={c.contact} className={c.contact === selected ? 'selected' : ''} onClick={() => setSelected(c.contact)}>
              <div className="row">
                <span className="contact">{c.contact}</span>
                <time>{shortTime(c.lastActivityAt)}</time>
              </div>
              <div className="row muted small">
                <span>{c.assignee ? (c.assignee === me.sub ? 'Assigned to you' : `Assigned to ${c.assignee}`) : 'Unassigned'}</span>
                {c.state === 'closed' && <span className="badge">closed</span>}
              </div>
            </li>
          ))}
        </ul>
        {cursor && (
          <button className="more" onClick={loadMore}>
            Load more
          </button>
        )}
      </aside>

      <section className="thread">
        {selected ? (
          <Thread key={workspace + selected} workspace={workspace} contact={selected} me={me} refreshKey={refreshKey} />
        ) : (
          <p className="muted pad">Select a conversation.</p>
        )}
      </section>
    </div>
  );
}

type Draft = { client_ref: string; text: string; state: 'sending' | 'failed' };

function Thread({ workspace, contact, me, refreshKey }: { workspace: string; contact: string; me: Me; refreshKey: number }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]); // replies not yet accepted by the server
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [m, c] = await Promise.all([api.messages(workspace, contact), api.conversation(workspace, contact).catch(() => null)]);
    setMessages(m.messages);
    setConv(c);
  }, [workspace, contact]);

  useEffect(() => {
    load().catch((e) => setNotice(e.message));
  }, [load, refreshKey]);

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [messages.length, drafts.length]);

  // Send with retries. The same client_ref every time, so the server stores ONE reply.
  const send = async (d: Draft) => {
    setDrafts((ds) => [...ds.filter((x) => x.client_ref !== d.client_ref), { ...d, state: 'sending' }]);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await api.reply(workspace, contact, d.text, d.client_ref);
        setDrafts((ds) => ds.filter((x) => x.client_ref !== d.client_ref));
        await load();
        return;
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) break; // our input was rejected: retrying won't help
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    setDrafts((ds) => ds.map((x) => (x.client_ref === d.client_ref ? { ...x, state: 'failed' } : x)));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText('');
    send({ client_ref: crypto.randomUUID(), text: t, state: 'sending' });
  };

  const act = async (action: 'claim' | 'release' | 'close' | 'reopen') => {
    setNotice('');
    try {
      await api.action(workspace, contact, action);
    } catch (e: any) {
      setNotice(e instanceof ApiError && e.status === 409 ? 'Someone else already holds this conversation.' : e.message);
    }
    await load();
  };

  const mine = conv?.assignee === me.sub;
  return (
    <>
      <div className="thread-head">
        <div>
          <strong>{contact}</strong>
          <div className="muted small">
            {conv?.assignee ? (mine ? 'Assigned to you' : `Assigned to ${conv.assignee}`) : 'Unassigned'} · {conv?.state ?? 'open'}
          </div>
        </div>
        <span className="spacer" />
        {!conv?.assignee && <button onClick={() => act('claim')}>Claim</button>}
        {mine && <button onClick={() => act('release')}>Release</button>}
        {conv?.state === 'closed' ? <button onClick={() => act('reopen')}>Reopen</button> : <button onClick={() => act('close')}>Close</button>}
      </div>
      {notice && <p className="error pad">{notice}</p>}

      <div className="messages">
        {messages.map((m) => (
          <div key={m.direction === 'in' ? m.message_id : m.client_ref} className={`bubble ${m.direction}`}>
            <div>{m.text}</div>
            <div className="meta">
              {shortTime(m.at)}
              {m.direction === 'out' && (
                <>
                  {' · '}
                  {m.author ?? 'system'} · <StatusTick status={m.status} />
                </>
              )}
            </div>
          </div>
        ))}
        {drafts.map((d) => (
          <div key={d.client_ref} className="bubble out draft">
            <div>{d.text}</div>
            <div className="meta">
              {d.state === 'sending' ? (
                'sending…'
              ) : (
                <>
                  <span className="error">not saved</span> · <button className="link" onClick={() => send(d)}>retry</button>
                </>
              )}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>

      <form className="composer" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${contact}`} aria-label="Reply" />
        <button className="primary" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </>
  );
}

function StatusTick({ status }: { status: string }) {
  const label: Record<string, string> = { queued: '🕓 queued', sent: '✓ sent', delivered: '✓✓ delivered', failed: '✗ failed' };
  return <span className={`status ${status}`}>{label[status] ?? status}</span>;
}

function shortTime(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
