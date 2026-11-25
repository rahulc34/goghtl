import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { config } from '../config.js';

// Minimal OpenID Connect client: authorization code + PKCE (S256), id_token verified with JWKS.

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

let discovery: Discovery | undefined;
let jwks: (JsonWebKey & { kid?: string })[] = [];

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${body?.error ?? ''} ${body?.error_description ?? ''}`.trim());
  return body;
}

async function getDiscovery(): Promise<Discovery> {
  discovery ??= await getJson(`${config.oidc.issuer}/.well-known/openid-configuration`);
  return discovery!;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

export function newPkce() {
  const verifier = randomToken(32);
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function authorizeUrl(p: { state: string; nonce: string; challenge: string }): Promise<string> {
  const d = await getDiscovery();
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile email',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export async function exchangeCode(code: string, verifier: string): Promise<{ id_token: string }> {
  const d = await getDiscovery();
  return getJson(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: verifier,
    }),
  });
}

async function keyFor(kid: string | undefined) {
  const d = await getDiscovery();
  let jwk = jwks.find((k) => k.kid === kid);
  if (!jwk) {
    // Unknown kid: the IdP may have rotated keys. Fetch once more.
    jwks = (await getJson(d.jwks_uri)).keys ?? [];
    jwk = jwks.find((k) => k.kid === kid) ?? (kid === undefined ? jwks[0] : undefined);
  }
  if (!jwk) throw new Error('id_token signed with an unknown key');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

// Verify signature (RS256 only), issuer, audience, expiry and nonce. Returns the claims.
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<Record<string, any>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('id_token is not a JWT');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error(`unexpected id_token alg ${header.alg}`); // never accept "none"/HS256

  const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), await keyFor(header.kid), Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('id_token signature invalid');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const d = await getDiscovery();
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== d.issuer) throw new Error('id_token issuer mismatch');
  if (!aud.includes(config.oidc.clientId)) throw new Error('id_token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('id_token expired');
  if (claims.nonce !== expectedNonce) throw new Error('id_token nonce mismatch');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token has no sub');
  return claims;
}
