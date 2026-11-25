# Decisions (half-page note)

<!-- Add one line the moment you decide something. Tidy it at 1:40. Keep it to about half a page. -->

## How to run
See README.md.

## What I built first and why
- [e.g. Payment flow first: it carries the most risk (double charges) and the checker tests it hardest.]

## Decisions where the brief was silent
- A new customer message on a closed conversation reopens it (keeps the assignee) — the customer needs an answer again.
- Claiming a conversation that does not exist yet creates it (brief requires this for `/__grader/claim`); same rule in the UI.
- Inbox order inside a conversation is Pigeon's `occurred_at`, not arrival time, because webhooks arrive out of order.
- A workspace "exists" if we have a Pigeon API key for it (`PIGEON_KEY_WS_*`); unknown workspaces in webhooks are acknowledged and ignored.
- Realtime `seq` comes from an atomic Mongo counter (not Redis) so it survives a Redis restart and stays unique across server copies.

## How it handles failure
- Retries / duplicates: [idempotency key + unique index on ...]
- Provider timeout: [timeout Xs, N retries with backoff; ...]
- Process killed: [state in Mongo with status field; on restart ...]
- Several instances: [no memory state; atomic updates / Redis lock on ...]

## What I cut, and what happens because of it
- [Feature] — not built. Impact: [...]

## Known problems (honest)
- [e.g. If Redis is down, X returns 503 instead of degrading.]

## Pre-prepared material
- First commit contains my own generic starter (server skeleton, retry/idempotency helpers, CLAUDE.md template), written before the session. Nothing in it is specific to the brief.

## AI usage
- Tool(s): [Claude Code ...]. Transcripts in `ai-logs/`.
- What I rejected or corrected from the AI: [examples]
