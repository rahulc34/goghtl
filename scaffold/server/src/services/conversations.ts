import { db, C, retryOnDuplicate } from '../lib/db.js';
import { emitEvent } from './events.js';

const conversations = () => db().collection(C.conversations);

const newConversation = () => ({ state: 'open', createdAt: new Date() });

// One conversation per contact per workspace; lastActivityAt only moves forward.
// A new message on a closed conversation reopens it (DECISIONS.md).
export async function touchConversation(workspace: string, contact: string, at: Date) {
  const before = await retryOnDuplicate(() =>
    conversations().findOneAndUpdate(
      { workspace, contact },
      {
        $setOnInsert: { assignee: null, createdAt: new Date() },
        $set: { state: 'open' },
        $max: { lastActivityAt: at },
      },
      { upsert: true, returnDocument: 'before' },
    ),
  );
  if (before?.state === 'closed') await emitEvent(workspace, 'conversation.updated', { contact, state: 'open' });
}

export type ClaimResult = { ok: true; assignee: string } | { ok: false; assignee: string | null };

/**
 * Agent claims a conversation. Exactly one agent can hold it.
 * ONE atomic operation: "set assignee = agent WHERE assignee is empty or already this agent".
 * - Held by someone else: the filter doesn't match, so the upsert tries to INSERT a second
 *   conversation for the same contact -> unique index rejects it (E11000) -> conflict.
 * - Doesn't exist yet: the upsert creates it with this agent as holder. If two agents create it
 *   at the same instant, the loser's retry sees the winner's row and gets a conflict.
 */
export async function claim(workspace: string, contact: string, agent: string): Promise<ClaimResult> {
  const attempt = () =>
    conversations().findOneAndUpdate(
      { workspace, contact, assignee: { $in: [null, agent] } },
      {
        $set: { assignee: agent, assignedAt: new Date() },
        $setOnInsert: { ...newConversation(), lastActivityAt: new Date() },
      },
      { upsert: true, returnDocument: 'before' },
    );

  let before;
  try {
    before = await retryOnDuplicate(attempt);
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
    const current = await conversations().findOne({ workspace, contact });
    return { ok: false, assignee: current?.assignee ?? null };
  }

  // Only announce a real change (the holder claiming again is not news).
  if (before?.assignee !== agent) {
    await emitEvent(workspace, 'conversation.assigned', { contact, assignee: agent });
  }
  return { ok: true, assignee: agent };
}

// Holder gives the conversation back. Returns false if this agent doesn't hold it.
export async function release(workspace: string, contact: string, agent: string): Promise<boolean> {
  const r = await conversations().updateOne({ workspace, contact, assignee: agent }, { $set: { assignee: null } });
  if (r.modifiedCount) await emitEvent(workspace, 'conversation.assigned', { contact, assignee: null });
  return r.modifiedCount === 1;
}

// Close or reopen. Returns false if the conversation doesn't exist.
export async function setState(workspace: string, contact: string, state: 'open' | 'closed'): Promise<boolean> {
  const r = await conversations().updateOne({ workspace, contact }, { $set: { state } });
  if (r.matchedCount === 0) return false;
  if (r.modifiedCount) await emitEvent(workspace, 'conversation.updated', { contact, state });
  return true;
}
