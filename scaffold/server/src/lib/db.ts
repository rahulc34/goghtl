import { MongoClient, type Db } from 'mongodb';
import { config } from '../config.js';

// One client per process. The driver reconnects on its own if Mongo restarts.
const client = new MongoClient(config.mongoUrl, {
  serverSelectionTimeoutMS: 5000, // fail fast instead of hanging a request
});

let database: Db | undefined;

// Called once at startup, before the server accepts traffic.
export async function connectDb(attempts = 30): Promise<Db> {
  for (let i = 1; ; i++) {
    try {
      await client.connect();
      database = client.db();
      await ensureIndexes(database);
      console.log('[mongo] connected');
      return database;
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[mongo] connect failed (${i}/${attempts}): ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Synchronous getter: safe to use anywhere after connectDb() has run.
export function db(): Db {
  if (!database) throw new Error('MongoDB not connected yet');
  return database;
}

// Kept for scaffold compatibility.
export async function getDb(): Promise<Db> {
  return database ?? connectDb();
}

export async function closeDb(): Promise<void> {
  await client.close().catch(() => {});
}

// Collection names in one place.
export const C = {
  conversations: 'conversations',
  messages: 'messages',
  events: 'events',
  counters: 'counters', // seq per workspace
} as const;

// createIndex is a no-op when the index already exists, so several copies
// starting at the same time is fine. Unique indexes are what make duplicates impossible.
async function ensureIndexes(d: Db): Promise<void> {
  await Promise.all([
    // One conversation per contact per workspace; inbox sorted by newest activity.
    d.collection(C.conversations).createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    d.collection(C.conversations).createIndex({ workspace: 1, lastActivityAt: -1 }),

    // Inbound: a Pigeon message_id is stored once, however many times the webhook arrives.
    d.collection(C.messages).createIndex(
      { workspace: 1, providerMessageId: 1 },
      { unique: true, partialFilterExpression: { direction: 'in' } },
    ),
    // Outbound: a client_ref is one reply, however many times it is requested.
    d.collection(C.messages).createIndex(
      { workspace: 1, clientRef: 1 },
      { unique: true, partialFilterExpression: { direction: 'out' } },
    ),
    // Messages of a conversation in order. Order is Pigeon's occurred_at, not arrival time
    // (webhooks arrive out of order); outbound messages use the time we accepted them.
    d.collection(C.messages).createIndex({ workspace: 1, contact: 1, occurredAt: 1 }),
    // Sender worker: find replies that are due.
    d.collection(C.messages).createIndex({ status: 1, nextAttemptAt: 1 }),

    // Real-time events: seq is unique within a workspace, replay with seq > after.
    d.collection(C.events).createIndex({ workspace: 1, seq: 1 }, { unique: true }),
  ]);
}

// Two concurrent upserts on the same unique key: one inserts, the other gets E11000.
// Running it again turns the loser into a plain update of the row the winner created.
export async function retryOnDuplicate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (err?.code === 11000) return fn();
    throw err;
  }
}
