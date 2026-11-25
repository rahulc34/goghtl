import { randomUUID } from 'node:crypto';
import { db, C } from '../lib/db.js';
import { sendMessage } from '../lib/pigeon.js';
import { takeSendToken, startCoolOff } from '../lib/rateLimit.js';
import { emitEvent } from '../services/events.js';

/**
 * Sends queued replies to Pigeon. Runs in EVERY server copy; they coordinate through Mongo.
 *
 * Taking a job is one atomic update: sendState -> 'sending' and nextAttemptAt -> now + LEASE.
 * If this copy dies mid-send, the lease runs out, the job is "due" again, and any copy
 * takes it over (well within the 60 s the brief allows). The resend uses the same
 * Idempotency-Key, so Pigeon never delivers it twice.
 */
const LEASE_MS = 15_000; // > Pigeon timeout (4 s) + margin
const IDLE_POLL_MS = 300;
const LOOPS = 4; // parallel sends per copy (the shared rate limit caps the total)

const owner = `${process.pid}-${randomUUID().slice(0, 8)}`;
let running = false;
let wake: (() => void) | null = null;

export function kickSender() {
  wake?.();
}

export function startSender() {
  running = true;
  const loops = Array.from({ length: LOOPS }, () => loop());
  return async function stop() {
    running = false;
    kickSender();
    await Promise.all(loops);
  };
}

async function loop() {
  while (running) {
    try {
      const worked = await runOnce();
      if (!worked) await idle();
    } catch (err: any) {
      console.warn('[sender]', err?.message ?? err);
      await idle(1000);
    }
  }
}

function idle(ms = IDLE_POLL_MS) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      if (wake === done) wake = null;
      resolve();
    }
    wake = done;
  });
}

const backoffMs = (attempts: number) => Math.min(500 * 2 ** attempts, 5000) * (0.75 + Math.random() * 0.5);

// Returns true if it did something (so the loop goes again immediately).
async function runOnce(): Promise<boolean> {
  const messages = db().collection(C.messages);
  const now = new Date();

  // 1. Lease one due job: pending and due, or 'sending' whose lease expired (its copy died).
  const job = await messages.findOneAndUpdate(
    { direction: 'out', sendState: { $in: ['pending', 'sending'] }, nextAttemptAt: { $lte: now } },
    { $set: { sendState: 'sending', nextAttemptAt: new Date(now.getTime() + LEASE_MS), leaseOwner: owner } },
    { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
  );
  if (!job) return false;

  // Only update the job while we still hold the lease.
  const mine = { _id: job._id, leaseOwner: owner, sendState: 'sending' };
  const later = (ms: number, extra: Record<string, unknown> = {}) =>
    messages.updateOne(mine, { $set: { sendState: 'pending', nextAttemptAt: new Date(Date.now() + ms), ...extra } });

  // 2. Shared per-workspace rate limit (and any Retry-After cool-off). Not our turn -> put it back.
  const wait = await takeSendToken(job.workspace);
  if (wait > 0) {
    await later(wait);
    return true;
  }

  // 3. Send. Same client_ref as Idempotency-Key on every attempt.
  const out = await sendMessage(job.workspace, job.contact, job.text, job.clientRef);

  switch (out.kind) {
    case 'accepted':
      // The visible status stays 'queued' until Pigeon's webhook says sent/delivered/failed.
      await messages.updateOne(mine, {
        $set: { sendState: 'accepted', acceptedAt: new Date(), ...(out.providerMessageId && { pigeonId: out.providerMessageId }) },
        $unset: { nextAttemptAt: '' },
      });
      break;

    case 'rate_limited':
      await startCoolOff(job.workspace, out.retryAfterMs); // every copy now waits
      await later(out.retryAfterMs + 250);
      break;

    case 'retry': // 503, timeout, outage: never give up, back off
      await later(backoffMs(job.attempts ?? 0), { attempts: (job.attempts ?? 0) + 1, lastError: out.reason });
      break;

    case 'rejected': {
      // Pigeon will never accept it (e.g. 400). Tell the agent it failed.
      const r = await messages.updateOne(
        { ...mine, statusRank: { $lt: 2 } },
        { $set: { sendState: 'rejected', status: 'failed', statusRank: 2, lastError: out.reason }, $unset: { nextAttemptAt: '' } },
      );
      if (r.modifiedCount) await emitEvent(job.workspace, 'message.status', { contact: job.contact, client_ref: job.clientRef, status: 'failed' });
      break;
    }
  }
  return true;
}
