import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, isKnownWorkspace } from '../config.js';
import { ah } from '../lib/http.js';
import { storeInbound, applyStatus } from '../services/inbound.js';

// HTTP side of the Pigeon webhook: authenticity, parsing, status codes.
// What happens to a valid event lives in services/inbound.ts.

const MAX_AGE_SECONDS = 5 * 60;

export const webhookRouter = Router();

// Raw body (Buffer): the signature is computed over the exact bytes Pigeon sent.
webhookRouter.post(
  '/pigeon',
  express.raw({ type: '*/*', limit: '1mb' }),
  ah(async (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    // Authenticity first. Anything wrong here is 401, never 5xx, and nothing is stored.
    const sig = verifySignature(req.get('x-pigeon-signature'), raw);
    if (sig !== 'ok') return res.status(401).json({ error: sig });

    // Genuine but unparseable -> 400.
    let event: any;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Body is not valid JSON' });
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      return res.status(400).json({ error: 'Missing event type' });
    }

    // Unknown workspace or unknown type: acknowledge and ignore, or Pigeon keeps retrying.
    if (!isKnownWorkspace(event.workspace)) return res.json({ ok: true, ignored: 'unknown workspace' });

    if (event.type === 'message.inbound') {
      const d = event.data;
      if (!d || typeof d.message_id !== 'string' || typeof d.from !== 'string') {
        return res.status(400).json({ error: 'Bad message.inbound data' });
      }
      await storeInbound(event.workspace, d.message_id, d.from, String(d.text ?? ''), event.occurred_at);
      return res.json({ ok: true }); // only after it is stored
    }

    if (event.type === 'message.status') {
      const d = event.data;
      if (!d || typeof d.client_ref !== 'string' || typeof d.status !== 'string') {
        return res.status(400).json({ error: 'Bad message.status data' });
      }
      await applyStatus(event.workspace, d.client_ref, d.status, d.message_id);
      return res.json({ ok: true });
    }

    return res.json({ ok: true, ignored: 'unknown event type' });
  }),
);

// Header: "t=<unix seconds>,v1=<hex>", v1 = HMAC-SHA256("<t>.<raw body>", secret)
function verifySignature(header: string | undefined, raw: Buffer): 'ok' | string {
  if (!header) return 'Missing signature';
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]+$/i.test(v1)) return 'Malformed signature';

  const expected = createHmac('sha256', config.pigeon.webhookSecret).update(`${t}.`).update(raw).digest();
  const given = Buffer.from(v1, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'Bad signature';

  // Checked after the HMAC, so the timestamp itself can't be forged.
  const age = Math.floor(Date.now() / 1000) - t;
  if (age > MAX_AGE_SECONDS || age < -MAX_AGE_SECONDS) return 'Stale timestamp';
  return 'ok';
}
