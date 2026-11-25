import { db, C, retryOnDuplicate } from '../lib/db.js';
import { emitEvent } from './events.js';
import { touchConversation } from './conversations.js';

// Status only moves forward. delivered/failed are final, so a late "sent" can't overwrite them.
export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };

// Store a customer message exactly once, then update its conversation.
export async function storeInbound(workspace: string, messageId: string, from: string, text: string, occurredAtRaw: unknown) {
  const occurredAt = parseDate(occurredAtRaw);
  const messages = db().collection(C.messages);

  // Upsert on the unique key: a duplicate (even at the same instant) never creates a second row.
  const doc = await retryOnDuplicate(() =>
    messages.findOneAndUpdate(
      { workspace, direction: 'in', providerMessageId: messageId },
      { $setOnInsert: { contact: from, text, occurredAt, receivedAt: new Date(), evented: false } },
      { upsert: true, returnDocument: 'after' },
    ),
  );

  await touchConversation(workspace, from, occurredAt);

  // Emit the realtime event once. If we crashed after storing but before emitting,
  // Pigeon's retry lands here with evented=false and the event goes out then.
  if (doc && !doc.evented) {
    await emitEvent(workspace, 'message.inbound', { contact: from, message_id: messageId, text, occurred_at: occurredAt });
    await messages.updateOne({ _id: doc._id }, { $set: { evented: true } });
  }
}

// Status of a reply we sent. Unknown client_ref -> ignored (no upsert).
export async function applyStatus(workspace: string, clientRef: string, status: string, providerMessageId: unknown) {
  const rank = STATUS_RANK[status];
  if (rank === undefined) return; // a status we don't know: ignore

  const updated = await db()
    .collection(C.messages)
    .findOneAndUpdate(
      { workspace, direction: 'out', clientRef, statusRank: { $lt: rank } },
      {
        $set: {
          status,
          statusRank: rank,
          statusAt: new Date(),
          ...(typeof providerMessageId === 'string' && { providerMessageId }),
        },
      },
      { returnDocument: 'after' },
    );
  // Nothing updated = unknown client_ref, duplicate, or an older status arriving late.
  if (updated) {
    await emitEvent(workspace, 'message.status', { contact: updated.contact, client_ref: clientRef, status });
  }
}

function parseDate(v: unknown): Date {
  const d = typeof v === 'string' ? new Date(v) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
