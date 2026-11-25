# Switchboard — task list

Tick a box by changing `[ ]` to `[x]` (or click it in a checkbox-enabled preview).
Order follows the brief: level 1 → 5 → 2 → 3. Commit after every sub-task group.

## HLD (what we build)

```
                        ┌──────────── GIVEN ─────────────┐
                        │ Pigeon :4010    Mock IdP :4020 │
                        └──┬───────▲──────────────▲──────┘
             webhooks      │       │ send reply   │ login (OIDC + PKCE)
   (signed, dup, unordered)│       │ (429/503/slow)│
                           ▼       │              │
┌──────────────────────────────────────────────────────────────────────┐
│ YOUR SERVER  (N copies, Express + TS, port from $PORT)                │
│                                                                       │
│  HTTP routes                                                          │
│   /webhooks/pigeon ── verify sig ─▶ inbound.service / status.service  │
│   /__grader/*  (x-grader-token)  ─┐                                   │
│   /api/*       (session cookie)  ─┼▶ conversation.service             │
│                                   │   claim / close / reply (queue)   │
│   /auth/login, /auth/callback ────┼▶ auth.service ──▶ sessions (Redis)│
│                                   │                                   │
│  Every change ─▶ emitEvent(ws, type, data)                            │
│                   1. seq = INCR seq:{ws}         (Redis)              │
│                   2. save event {ws, seq, ...}   (Mongo)              │
│                   3. PUBLISH events:{ws}         (Redis pub/sub)      │
│                                                                       │
│  /ws?workspace=&after= ◀── replay from Mongo, then live from pub/sub  │
│                                                                       │
│  Sender worker (runs in every copy)                                   │
│   take 1 queued reply (atomic, lease 30s) ─▶ rate limit (Redis,       │
│   per workspace 8 + 4/s) ─▶ POST Pigeon (Idempotency-Key=client_ref)  │
│   ─▶ ok: sent │ 429/503/timeout: back to queue, retry later           │
└───────────┬──────────────────────────────────┬────────────────────────┘
            ▼                                  ▼
   ┌────────────────────┐            ┌──────────────────────┐
   │ MongoDB            │            │ Redis                │
   │  conversations     │            │  seq counters        │
   │  messages (in+out) │            │  pub/sub events      │
   │  events (for ws)   │            │  rate-limit buckets  │
   └────────────────────┘            │  sessions, PKCE state│
                                     └──────────────────────┘
            ▲
            │ HTTP /api  +  WebSocket /ws   (Vite proxy in dev)
┌───────────┴────────────┐
│ REACT APP :5173        │
│ login → workspace →    │
│ inbox → conversation   │
│ reply + status ticks   │
└────────────────────────┘
```

## Task 0 — Foundation
- [x] 0.1 Settings from env (PORT, Mongo, Redis, Pigeon keys, grader token, IdP)
- [x] 0.2 Connect Mongo + Redis, create indexes at startup
- [x] 0.3 `/healthz` = 200 only when Mongo + Redis connected
- [x] 0.4 Async error wrapper + error handler + graceful shutdown (SIGTERM)
- [ ] 0.5 Run `npm run check` once to see what it expects

## Task 1 — Grader endpoints (base)
- [ ] 1.1 `x-grader-token` middleware (401 if missing/wrong)
- [ ] 1.2 `POST /__grader/reset` — wipe app data in Mongo + Redis
- [ ] 1.3 `GET /__grader/snapshot` — contacts, inbound ids, assignee, outbound statuses

## Task 2 — Receive messages (webhook) → L1, L2, L4
- [ ] 2.1 Raw body + HMAC signature + 5-min timestamp → 401
- [ ] 2.2 Unparseable → 400; unknown type / workspace → 200 and ignore
- [ ] 2.3 Inbound: save with unique `message_id`, upsert conversation (last activity)
- [ ] 2.4 Status: update reply status, never backwards; unknown `client_ref` → 200 ignore
- [ ] 2.5 Answer 2xx only after saving

## Task 3 — Claim → L1
- [ ] 3.1 `POST /__grader/claim` atomic: 200 holder / 409 other; creates conversation if missing
- [ ] 3.2 Close and reopen

## Task 4 — Send replies → L1, L2, L3
- [ ] 4.1 `POST /__grader/reply`: save `queued`, unique (workspace, client_ref), 202; duplicate → 202
- [ ] 4.2 Sender worker: atomically take a reply with a lease (dead copy's work retaken < 60 s)
- [ ] 4.3 Call Pigeon with `Idempotency-Key = client_ref` + timeout
- [ ] 4.4 429 / 503 / timeout / outage → stay queued, retry later (`Retry-After`)
- [ ] 4.5 Per-workspace rate limit in Redis (8, refill 4/s), shared by all copies

## Task 5 — Real-time → L5, L3
- [ ] 5.1 `emitEvent`: seq per workspace (Redis INCR), save event in Mongo
- [ ] 5.2 Broadcast through Redis pub/sub to every copy
- [ ] 5.3 `/ws?workspace=&after=`: check session + membership, replay missed, then live

## Task 6 — Login and API → L5
- [ ] 6.1 `/auth/login`: redirect to IdP with PKCE (state + verifier in Redis)
- [ ] 6.2 `/auth/callback`: exchange code, read `workspaces` claim, session in Redis, cookie
- [ ] 6.3 `/api/me`, `/api/conversations?workspace=` with 401 / 403
- [ ] 6.4 UI endpoints: messages of a conversation, reply, claim, close/reopen (same services)

## Task 7 — Frontend
- [ ] 7.1 Login button, workspace picker
- [ ] 7.2 Inbox list (newest first, paginated)
- [ ] 7.3 Conversation view: messages, reply box, status ticks
- [ ] 7.4 Claim / close / reopen buttons
- [ ] 7.5 Live updates via WebSocket, reconnect with `after=lastSeq`

## Task 8 — Test against the check (ongoing)
- [ ] `npm run check` after tasks 2, 3, 4
- [ ] `npm run check -- --levels 5` after task 6
- [ ] `npm run check:full` for levels 2 and 3

## Task 9 — Submission (at 1:50)
- [ ] `npm run check:full` → commit `CHECK_REPORT.json`
- [ ] `README.md` + `DECISIONS.md` (cuts, assumptions, what is still wrong)
- [ ] Export AI chats into `ai-logs/`
- [ ] Commit, push, make repo public, send the form with the commit id

## Cut unless time is left
- Encrypted notes (`PROTOCOL.md`), Elasticsearch search, Paybox billing
- Maybe 1–2 tests: status ordering, signature check
