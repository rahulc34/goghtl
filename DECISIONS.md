# Decisions (half-page note)

<!-- Add one line the moment you decide something. Tidy it at 1:40. Keep it to about half a page. -->

## How to run
See README.md.

## What I built first and why
- [e.g. Payment flow first: it carries the most risk (double charges) and the checker tests it hardest.]

## Decisions where the brief was silent
- [Decision] — [reason]

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
