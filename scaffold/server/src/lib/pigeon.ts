import { config } from '../config.js';

// HTTP client for Pigeon's send API. Turns every possible answer into one of four outcomes.
export type SendOutcome =
  | { kind: 'accepted'; providerMessageId?: string }
  | { kind: 'rate_limited'; retryAfterMs: number } // 429
  | { kind: 'retry'; reason: string } // 5xx, timeout, network: try again later
  | { kind: 'rejected'; status: number; reason: string }; // other 4xx: will never succeed

const TIMEOUT_MS = 4000; // Pigeon sometimes answers after 12 s; we retry with the same Idempotency-Key

export async function sendMessage(workspace: string, to: string, text: string, clientRef: string): Promise<SendOutcome> {
  const apiKey = config.pigeon.apiKeys[workspace];
  if (!apiKey) return { kind: 'rejected', status: 0, reason: 'no API key for workspace' };

  let res: Response;
  try {
    res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        // Same key on every retry: Pigeon returns the original result and does not send again.
        'idempotency-key': clientRef,
      },
      body: JSON.stringify({ to, text, client_ref: clientRef }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    return { kind: 'retry', reason: err?.name === 'TimeoutError' ? 'timeout' : `network: ${err?.message}` };
  }

  if (res.ok) {
    const body: any = await res.json().catch(() => ({}));
    return { kind: 'accepted', providerMessageId: typeof body?.id === 'string' ? body.id : undefined };
  }
  await res.body?.cancel().catch(() => {});

  if (res.status === 429) {
    const seconds = Number(res.headers.get('retry-after'));
    return { kind: 'rate_limited', retryAfterMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000 };
  }
  if (res.status >= 500 || res.status === 408) return { kind: 'retry', reason: `HTTP ${res.status}` };
  return { kind: 'rejected', status: res.status, reason: `HTTP ${res.status}` };
}
