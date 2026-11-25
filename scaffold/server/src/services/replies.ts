import { db, C, retryOnDuplicate } from '../lib/db.js';
import { emitEvent } from './events.js';
import { touchConversation } from './conversations.js';
import { kickSender } from '../workers/sender.js';

/**
 * Accept a reply. Once this returns, the reply is safely stored and WILL be sent
 * (by the sender worker of any server copy), even if this process dies right now.
 *
 * Idempotent on (workspace, client_ref): asking twice, even at the same instant,
 * stores one reply. Both callers get the same answer.
 */
export async function queueReply(workspace: string, contact: string, text: string, clientRef: string, author: string | null) {
  const now = new Date();
  const r = await retryOnDuplicate(() =>
    db()
      .collection(C.messages)
      .updateOne(
        { workspace, direction: 'out', clientRef },
        {
          $setOnInsert: {
            contact,
            text,
            author,
            occurredAt: now,
            // What the agent sees: queued -> sent -> delivered | failed (from Pigeon's webhooks)
            status: 'queued',
            statusRank: 0,
            // Internal send state: pending -> sending (leased) -> accepted | rejected
            sendState: 'pending',
            nextAttemptAt: now,
            attempts: 0,
          },
        },
        { upsert: true },
      ),
  );

  // The conversation exists even if the contact never wrote (brief: grader reply).
  await touchConversation(workspace, contact, now);

  if (r.upsertedCount === 1) {
    await emitEvent(workspace, 'message.outbound', { contact, client_ref: clientRef, text, status: 'queued', author });
    kickSender(); // send now instead of waiting for the next poll
  }
}
