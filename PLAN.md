# Design: data model and API

Architecture diagram and build order: `TASKS.md`. Choices and known problems: `DECISIONS.md`.

## MongoDB

### `conversations` — one per contact per workspace
| Field | Notes |
| --- | --- |
| workspace, contact | **unique** `(workspace, contact)` |
| assignee | agent id or `null`; set only by the atomic claim |
| state | `open` / `closed` |
| lastActivityAt | `$max` of message times; inbox index `(workspace, lastActivityAt desc)` |

### `messages` — inbound and outbound in one collection
| Field | Notes |
| --- | --- |
| direction | `in` / `out` |
| workspace, contact, text, occurredAt | order index `(workspace, contact, occurredAt)` |
| providerMessageId | inbound: **unique** `(workspace, providerMessageId)` where `direction=in` |
| evented | inbound: realtime event already emitted |
| clientRef | outbound: **unique** `(workspace, clientRef)` where `direction=out` |
| status, statusRank | outbound, visible: `queued → sent → delivered / failed`; only moves forward |
| sendState, nextAttemptAt, leaseOwner, attempts | outbound, worker: `pending → sending (lease) → accepted / rejected`; index `(sendState, nextAttemptAt)` |
| author | outbound: agent `sub`, or `null` for the grader |

### `events` — realtime log for replay
`{ workspace, seq, type, contact, ... }`, **unique** `(workspace, seq)`.

### `counters`
`{ _id: "seq:<workspace>", seq }` — atomic `$inc` gives the next `seq`.

## Redis (all keys `sb:*`)
| Key | Purpose |
| --- | --- |
| `sb:sess:<id>` | session `{sub, name, email, workspaces}`, 8 h (kept by `/__grader/reset`) |
| `sb:pkce:<state>` | login in progress `{verifier, nonce}`, 10 min, single use |
| `sb:rl:<ws>` | token bucket for sends to Pigeon |
| `sb:cooloff:<ws>` | no sends until this time (after a `429`) |
| channel `sb:events:<ws>` | pub/sub fan-out of events to every copy |

## HTTP
| Method | Path | Notes |
| --- | --- | --- |
| GET | `/healthz` | 200 when ready, 503 while shutting down |
| POST | `/webhooks/pigeon` | signed; 401 / 400 / 2xx rules from `PIGEON.md` |
| POST | `/__grader/reset`, `/reply`, `/claim`; GET `/snapshot` | `x-grader-token` |
| GET | `/auth/login`, `/auth/callback`; POST `/auth/logout` | OIDC code + PKCE |
| GET | `/api/me` | 401 without session |
| GET | `/api/conversations?workspace=&state=&cursor=&limit=` | inbox, newest first; 403 if not a member |
| GET | `/api/conversations/:contact?workspace=` | one conversation |
| GET | `/api/conversations/:contact/messages?workspace=` | oldest first |
| POST | `/api/conversations/:contact/reply?workspace=` `{text, client_ref}` | 202; same `client_ref` = same reply |
| POST | `/api/conversations/:contact/claim` · `release` · `close` · `reopen` `?workspace=` | claim 200 / 409 |
| WS | `/ws?workspace=&after=` | session cookie; frames `{seq, type, ...}` |
