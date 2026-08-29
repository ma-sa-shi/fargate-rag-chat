---
name: run
description: Start and verify the ai_app local development environment with Docker Compose. Use when asked to run, start, restart, or confirm the application is running locally.
---

# Local startup rules

## Critical rules

Always:

- Run Docker Compose from the repository root.
- Wait until the application is actually ready before reporting success.
- Verify both the backend and frontend after startup.
- Ask the user if required environment variables are missing.

Never:

- Assume containers are ready immediately after `docker compose up`.
- Invent API keys or credentials.
- Treat running containers as proof that the application works.

---

## Start

Run from the repository root:

```bash
docker compose up --build -d
```

Use `-d` (detached) — the foreground form never returns, which blocks any session waiting on the command. Follow progress with `docker compose logs -f backend` if needed.

The first startup can take several minutes because the backend container installs Python dependencies, initializes the database, and then starts Uvicorn.

---

## Required environment

Backend, frontend, and MySQL share a single repository-root `.env`. If it is missing,
copy `.env.example` and have the user fill in real values.

`.env.example` is the inventory: compare `.env` against it rather than against a list
kept here. Its uncommented lines are what local startup needs, its commented blocks are
optional overrides and deploy-only variables, and each entry says when it does not apply —
`DATABASE_URL`, for instance, is marked as read by no application code.

If required values are missing or obviously placeholders, stop and ask the user instead
of inventing credentials or API keys.

---

## Verify startup

Verify readiness in this order.

1. Containers

```bash
docker compose ps
```

`rdb` should be healthy.

2. FastAPI

```bash
curl -s http://localhost:8000/api/system/health
```

Expected:

```json
{"status":"success",...}
```

3. Database

```bash
curl -s http://localhost:8000/api/system/db-test
```

Expected:

```json
{"status":"success",...}
```

4. Chroma

```bash
curl -s http://localhost:8000/api/system/chroma-test
```

Expected:

```json
{"status":"success",...}
```

This issues a `similarity_search`, which embeds the query through OpenAI — so it also
proves `OPENAI_API_KEY` works. A 500 here is as likely to be a bad key as a broken Chroma
client. `COHERE_API_KEY` is still unexercised (see below).

5. Frontend

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000
```

Expected:

```
307
```

`app/page.tsx` redirects to `/auth` when there is no session cookie, so an unauthenticated
request returns 307, not 200. A 200 here would mean the redirect guard is gone. Add `-L`
if you want to follow it to the sign-in page.

6. If startup appears stalled

```bash
docker compose logs backend
```

Look for:

```
Uvicorn running
```

---

## Functional verification

This Skill only verifies that the application starts correctly.

For end-to-end verification (upload → ingest → chat → persistence), use the `verify` Skill.

---

## Authentication

Protected pages require the httpOnly `session_token` cookie.

Calling FastAPI endpoints directly bypasses the Next.js route handler that adds request headers. Use the browser UI when validating user-facing behavior.

---

## Shutdown

Use:

```bash
docker compose down
```

Before using:

```bash
docker compose down -v
```

warn the user that the local MySQL volume will be deleted.

---

## API key behavior

Neither key prevents Uvicorn from starting — the lifespan handler constructs the OpenAI
and Cohere clients without calling them.

`OPENAI_API_KEY` is exercised by the `chroma-test` check above, because the
`similarity_search` embeds its query. `COHERE_API_KEY` is not exercised until a chat
request reaches the reranker, so a fully green startup is still not proof that reranking
works.

Use the `verify` Skill to confirm end-to-end functionality.
