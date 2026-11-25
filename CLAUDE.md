# CLAUDE.md — project rules for the AI

## What we are building
Switchboard: a shared team inbox. Pigeon webhooks bring customer messages; human agents log in (OIDC), claim, reply and close conversations in real time. Several workspaces, strictly isolated.
"Agent" = a HUMAN support agent at the business. No AI bots.
Full plan, schema and API: `PLAN.md`. Decisions log: `DECISIONS.md`.

## Stack and layout
- Backend: Express + TypeScript in `scaffold/server/src/` (grader runs `npm --prefix scaffold/server start`, see `switchboard.json`)
- Frontend: React + Vite in `scaffold/web/src/` (proxies `/api`, `/auth`, `/healthz`, `/ws` to the server)
- MongoDB + Redis via `docker-compose.yml`; settings from env in `scaffold/server/src/config.ts`
- Provided services: Pigeon :4010 (messaging), Mock IdP :4020 (login), Paybox :4030 (bonus only)
- Given files, DO NOT EDIT: `harness/`, `pigeon/`, `idp/`, `paybox/`, `docker-compose.yml`, `*.md` from the packet

## Commands
- `npm run up` / `npm run doctor` — services
- `npm run scaffold:server` / `npm run scaffold:web` — dev
- `npm run inbound` (customer writes now) · `npm run quiet` / `drizzle` · `npm run report` (what Pigeon saw)
- `npm run check` — level 1 (STOP the dev server first; it DELETES app data and starts the server itself)
- `npm run check:full` — levels 1,2,3,5 (~4 min), writes CHECK_REPORT.json

## Non-negotiable rules (the checker attacks these)
1. **Listen on `process.env.PORT`.** The check picks the port. Health endpoint `/healthz`.
2. **No state in memory.** Several copies of the server run at once; process gets killed and restarted. State lives in Mongo/Redis.
3. **Webhooks are idempotent.** Pigeon may resend, reorder or duplicate. Dedupe on the provider's message/event id with a unique index.
4. **Every outbound call has a timeout** and retries with backoff; only retry when an idempotency key makes it safe.
5. **Crash halfway must be recoverable.** Record intent in Mongo (`pending`) BEFORE calling Pigeon; a worker resumes pending items after restart.
6. **Concurrency:** atomic Mongo updates (`findOneAndUpdate` with conditions) or unique indexes, not read-then-write.
7. **Graceful shutdown** on SIGTERM/SIGINT. Clear HTTP codes: 400, 401/403, 404, 409, 503 when a dependency is down. Never hang.
8. **Workspace isolation:** a user only sees data from workspaces they belong to; roles admin/agent.

## How to work with me (the human)
- Do ONE task per request. Don't refactor unrelated code.
- Don't read large files (REFERENCE.html, package-lock.json) or whole folders. Use grep / REFERENCE.pdf pages.
- Before writing code for a new flow, list its edge cases in 3–5 bullets.
- After a change, tell me how to verify it (command or curl).
- If the brief is unclear, propose a decision in one line and add it to `DECISIONS.md`.
- Keep code simple and readable. I must be able to explain every line.
