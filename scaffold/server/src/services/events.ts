import { db, C } from '../lib/db.js';
import { getRedis } from '../lib/redis.js';

export type EventType = 'message.inbound' | 'message.status' | 'conversation.assigned' | 'conversation.updated' | 'message.outbound';

/**
 * The ONE place every change goes through.
 * 1. seq: next number for this workspace (atomic Mongo counter, so it survives a Redis restart
 *    and is shared by all server copies).
 * 2. Save the event in Mongo, so a client reconnecting with ?after=<seq> can replay it.
 * 3. Publish on Redis, so every server copy can push it to its WebSocket clients (task 5).
 */
export async function emitEvent(workspace: string, type: EventType, data: Record<string, unknown>) {
  const counter = await db()
    .collection<{ _id: string; seq: number }>(C.counters)
    .findOneAndUpdate({ _id: `seq:${workspace}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  const seq = counter!.seq;

  const event = { seq, type, ...data };
  await db().collection(C.events).insertOne({ workspace, ...event, at: new Date() });

  // Best effort: if publish fails, the event is still in Mongo and clients get it on reconnect.
  await getRedis()
    .publish(`sb:events:${workspace}`, JSON.stringify(event))
    .catch((err) => console.warn('[events] publish failed', err.message));
  return event;
}
