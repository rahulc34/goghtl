# Switchboard

A shared team inbox. Customers write through Pigeon (a simulated messaging provider); support agents sign in,
see conversations arrive in real time, claim them, reply, and close them. Several workspaces share one deployment
and never see each other's data. Built to keep working when the network is bad, a process is killed, or several
copies run at once.

## Run from a clean clone

Requires **Node 22** and **Docker** (or your own MongoDB and Redis).

```bash
npm run up                  # MongoDB, Redis, Pigeon, mock IdP, Paybox (Docker) and a health check
npm run scaffold:install    # install server + web dependencies (same as switchboard.json "install")

npm run scaffold:server     # API + webhook + WebSocket on http://localhost:4000
npm run scaffold:web        # React app on http://localhost:5173  (open this)
```

Sign in on the mock IdP page by clicking a user (no passwords). Eli Novak belongs to both workspaces.
Customer messages arrive every few seconds; `npm run inbound` sends one now, `npm run quiet` / `npm run drizzle`
stop and restart them.

No Docker: `npm run mocks` starts the simulators with plain Node; set `MONGO_URL` and `REDIS_URL`.

Configuration comes only from the environment (defaults in `.env.example`, optional `.env` in the repo root).
The server listens on `PORT`.

## Check

Stop your dev server first: the check starts the server itself and **deletes application data**.

```bash
npm run check          # level 1
npm run check:full     # levels 1, 2, 3, 5 -> CHECK_REPORT.json
```

On Windows the check cannot kill the server (see `DECISIONS.md`); `scripts/make-check-win.js` makes a local
copy with that one line fixed. Results: `CHECK_REPORT.json` (unmodified, Windows) and
`CHECK_REPORT.windows-patched.json` (75/75).

## How it works

```
Pigeon --signed webhook--> /webhooks/pigeon --> Mongo (unique ids) --> emitEvent: seq + event log + Redis pub/sub
Agent  --reply---------->  /api/.../reply   --> Mongo "queued" (202) --> sender worker (any copy, leased)
                                                 --> rate limit (Redis) --> Pigeon /v1/messages (Idempotency-Key)
Browser <--WebSocket /ws?workspace=&after=  <-- replay from Mongo, then live from Redis (any copy)
```

Server code (`scaffold/server/src`):

| Folder | What |
| --- | --- |
| `routes/` | HTTP only: `webhook.ts`, `grader.ts`, `auth.ts` (OIDC), `api.ts` (UI API, 401/403) |
| `services/` | Business logic shared by the UI and grader routes: inbound, conversations (claim), replies, events, sessions |
| `workers/sender.ts` | Sends queued replies; retries, `Retry-After`, failover via leases |
| `lib/` | Mongo (indexes), Redis, Pigeon client, rate limiter, OIDC, errors |
| `ws.ts` | WebSocket hub: auth on upgrade, replay, live fan-out, gap fill |

Web app (`scaffold/web/src`): `App.tsx` (inbox, conversation, reply, claim/close), `useLive.ts` (WebSocket with
reconnect + `after=`), `api.ts`.

More: `DECISIONS.md` (choices, cuts, known problems), `PLAN.md` (data model and API), `TASKS.md` (build order).
