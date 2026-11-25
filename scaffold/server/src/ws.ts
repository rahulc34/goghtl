import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { db, C } from './lib/db.js';
import { getSubscriber } from './lib/redis.js';
import { getSession, sessionIdFromCookieHeader, roleIn } from './services/sessions.js';

/**
 * GET /ws?workspace=<id>&after=<seq>
 *
 * Every server copy subscribes to Redis once and forwards events to its own sockets, so a browser
 * on copy 1 gets what copy 2 processed. Each socket sends frames with strictly increasing seq:
 *  - on connect: replay from Mongo everything after `after` (or after "now" if not given),
 *    while buffering live events that arrive meanwhile;
 *  - live: skip anything already sent; if a seq is missing (another copy published out of
 *    order), fill the gap from Mongo first.
 */

type Frame = { seq: number; type: string; [k: string]: unknown };

const CHANNEL_PREFIX = 'sb:events:';
const sockets = new Map<string, Set<Client>>(); // workspace -> connected clients on THIS copy

class Client {
  private lastSent: number;
  private ready = false;
  private buffer: Frame[] = [];
  private chain: Promise<void> = Promise.resolve(); // deliveries run one at a time, in order

  constructor(private ws: WebSocket, private workspace: string, after: number) {
    this.lastSent = after;
  }

  // Called once, right after the client is registered for live events.
  async start() {
    const missed = await fetchEvents(this.workspace, this.lastSent);
    for (const f of missed) this.send(f);
    this.ready = true;
    const buffered = this.buffer;
    this.buffer = [];
    for (const f of buffered) this.onLive(f);
  }

  onLive(frame: Frame) {
    if (!this.ready) {
      this.buffer.push(frame);
      return;
    }
    this.chain = this.chain.then(() => this.deliver(frame)).catch((err) => console.warn('[ws] deliver', err.message));
  }

  private async deliver(frame: Frame) {
    if (frame.seq <= this.lastSent) return; // already sent (replay overlap or duplicate)
    if (frame.seq > this.lastSent + 1) {
      // Gap: an earlier event is in Mongo but its publish hasn't reached us yet. Fill from Mongo.
      for (let tries = 0; tries < 3; tries++) {
        const gap = await fetchEvents(this.workspace, this.lastSent, frame.seq);
        for (const f of gap) this.send(f);
        if (this.lastSent >= frame.seq - 1) break;
        await new Promise((r) => setTimeout(r, 150)); // the other copy may still be writing it
      }
    }
    this.send(frame);
  }

  private send(frame: Frame) {
    if (frame.seq <= this.lastSent) return;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
    this.lastSent = frame.seq;
  }
}

// Events with after < seq (< before, if given), oldest first.
async function fetchEvents(workspace: string, after: number, before?: number): Promise<Frame[]> {
  const seq: Record<string, number> = { $gt: after };
  if (before !== undefined) seq.$lt = before;
  return (await db()
    .collection(C.events)
    .find({ workspace, seq }, { projection: { _id: 0, workspace: 0, at: 0 } })
    .sort({ seq: 1 })
    .limit(1000)
    .toArray()) as unknown as Frame[];
}

async function currentSeq(workspace: string): Promise<number> {
  const c = await db().collection<{ _id: string; seq: number }>(C.counters).findOne({ _id: `seq:${workspace}` });
  return c?.seq ?? 0;
}

function refuse(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  // One subscription per copy, for all workspaces.
  const sub = getSubscriber();
  await sub.psubscribe(`${CHANNEL_PREFIX}*`);
  sub.on('pmessage', (_pattern, channel, message) => {
    const clients = sockets.get(channel.slice(CHANNEL_PREFIX.length));
    if (!clients?.size) return;
    let frame: Frame;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    for (const c of clients) c.onLive(frame);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleUpgrade(wss, req, socket, head).catch((err) => {
      console.warn('[ws] upgrade failed', err?.message);
      refuse(socket, 503, 'Service Unavailable');
    });
  });

  // Drop connections that stopped answering pings (laptop closed, network gone).
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', (ws) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  return async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down'); // clients reconnect with after=
    wss.close();
  };
}

async function handleUpgrade(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');

  // Same session cookie as the HTTP API. No session -> 401; not a member -> 403. No upgrade.
  const session = await getSession(sessionIdFromCookieHeader(req.headers.cookie));
  if (!session) return refuse(socket, 401, 'Unauthorized');
  const workspace = url.searchParams.get('workspace') ?? '';
  if (!roleIn(session, workspace)) return refuse(socket, 403, 'Forbidden');

  // Where to start. Read BEFORE the handshake completes, so nothing that happens after the
  // client sees "open" can fall between this number and the live subscription.
  const afterParam = Number(url.searchParams.get('after'));
  const after = url.searchParams.has('after') && Number.isInteger(afterParam) && afterParam >= 0 ? afterParam : await currentSeq(workspace);

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
    const client = new Client(ws, workspace, after);
    // Register first (live events get buffered), then replay from Mongo.
    let set = sockets.get(workspace);
    if (!set) sockets.set(workspace, (set = new Set()));
    set.add(client);
    ws.on('close', () => {
      set!.delete(client);
      if (!set!.size) sockets.delete(workspace);
    });
    ws.on('error', () => ws.terminate());
    client.start().catch((err) => {
      console.warn('[ws] replay failed', err?.message);
      ws.close(1011, 'replay failed'); // client reconnects with after=
    });
  });
}
