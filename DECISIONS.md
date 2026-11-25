# Decisions

## What I built, in this order, and why
1. **Webhook intake** (signature, dedupe, ordering) and the grader endpoints first: everything else depends on messages being stored exactly once, and the check needs `reset`/`snapshot` to see anything.
2. **Claim** (one atomic Mongo update) and **replies** (stored as `queued`, then sent by a leased background worker): this is where loss and double-sends happen.
3. **Realtime** (event log + Redis fan-out) and **OIDC login**, then the **React inbox**.

Result: full check (levels 1, 2, 3, 5) **75/75** — see "Check report on Windows" below for how that was measured.

## How it handles failure
- **Duplicates / replays**: unique indexes — inbound on `(workspace, message_id)`, outbound on `(workspace, client_ref)`, conversation on `(workspace, contact)`. Concurrent upserts that lose with E11000 are retried as updates.
- **Forged / stale webhooks**: HMAC over the raw body, constant-time compare, timestamp within 5 min → else `401`. Unparseable → `400`. Unknown type/workspace/client_ref → `2xx` and ignored. `2xx` only after the write.
- **Out-of-order statuses**: status has a rank (`queued < sent < delivered = failed`); updates only move forward.
- **Pigeon slow / 503 / outage**: 4 s timeout, retry forever with capped backoff; every attempt uses `Idempotency-Key = client_ref`, so a send that "timed out" but succeeded is not sent again.
- **Rate limit**: a token bucket per workspace in Redis (Lua, Redis clock), shared by all copies, set below Pigeon's limit. A `429` sets a per-workspace cool-off in Redis that every copy respects.
- **Process killed**: a reply is in Mongo before `202`. The worker leases a job for 15 s; if the copy dies, the lease expires and any copy resends it (same idempotency key).
- **Several copies**: no state in memory. `seq` comes from an atomic Mongo counter; events are stored in Mongo and fanned out with Redis pub/sub; each socket fills gaps from Mongo so `seq` never goes backwards. Sessions and PKCE state are in Redis.

## Decisions where the brief was silent
- A new customer message on a closed conversation reopens it (assignee kept).
- `admin` and `agent` have the same rights; the brief defines no difference.
- In the UI an agent claims as themselves (`sub` from the session); the body never names the agent.
- A workspace exists if there is a Pigeon API key for it (`PIGEON_KEY_WS_*`).
- Message order is Pigeon's `occurred_at`; outbound messages use the time we accepted them.
- Sessions: random 256-bit id, HttpOnly + SameSite=Lax cookie, data in Redis for 8 h. id_token verified (RS256/JWKS, iss, aud, exp, nonce); PKCE S256; `state` single-use and bound to the browser by a cookie.

## What I cut, and what that means
- **Encrypted notes, Elasticsearch search, Paybox billing**: not built. No notes feature at all; no search; no billing.
- **Automated tests**: none written; I relied on the provided check plus scripted manual tests. The first ones I would add: status ordering, webhook signature/timestamp, claim race.
- **Message pagination** inside a conversation (capped at the latest 500) and a last-message preview in the inbox list.

## Known problems
- **Realtime gap fill**: if another copy's event takes more than ~0.5 s to be written, a live socket skips it (it is still in Mongo; the UI reloads on reconnect, but that socket never receives that frame).
- **Crash between storing an inbound message and emitting its event**: on Pigeon's retry the event is emitted then — but if the crash came after emitting and before marking it, the event is emitted twice (two seqs, same `message_id`). The UI reloads, so it only shows once.
- **A status webhook Pigeon gives up on** (6 attempts) leaves the reply at `queued`/`sent` forever: there is no reconciliation with Pigeon.
- The `events` collection grows without limit (no TTL / compaction).
- A user's workspaces are read at login; role changes in the IdP apply only after the next login (≤ 8 h).

## Check report on Windows
`harness/check.js` kills servers with `process.kill(-pid)`, which does nothing on Windows: the "killed" server keeps port 4001, the restart fails with `EADDRINUSE`, and the check stops at level 2 with `502`. So the unmodified run (`CHECK_REPORT.json`) shows **24/75** (level 1 complete, then stopped).
To test levels 2 and 3 for real I ran a local copy whose only change is that kill (`taskkill` on the process tree and on whatever listens on the instance port): `scripts/make-check-win.js` makes that copy. Its full run is `CHECK_REPORT.windows-patched.json`: **75/75**. On Linux the unmodified check should behave like the patched one.

## Pre-prepared material
Before the session I wrote generic templates (`CLAUDE.md`, `PLAN.md`, `DECISIONS.md`, a task-list format), committed separately right after the starter. No product code was prepared in advance.

## AI usage
Claude Code (transcripts in `ai-logs/`). I asked for a design and edge cases before each task, had the structure changed to `lib/ routes/ services/ workers/`, reviewed each step, and ran the check after every task.
