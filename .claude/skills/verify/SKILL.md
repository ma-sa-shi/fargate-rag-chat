---
name: verify
description: Verify a change to the ai_app RAG platform end-to-end - upload and ingest a document, run a chat-stream query, and confirm SSE events, grade outcome, and persisted chat_histories/chat_details rows. Use after changing the backend RAG pipeline (nodes/chains/prompts/workflows), ingestion, chat endpoints, or the chat UI, before considering the change done.
---

# Verifying ai_app changes end-to-end

Assume the app is already up (see the `run` skill). If not, bring it up first.

## Golden path

1. **Upload**
   - Upload a document (via the UI or the document upload endpoint).
   - Verify in the `docs` table (or an API exposing the same DB state) that a row was created with `status='uploaded'`.
2. **Ingest**
   - Call `POST /api/documents/{doc_id}/embeddings`.
   - Verify in the `docs` table that the status transitions:
     `uploaded → processing → ingested` (or `uploaded → processing → failed` on error).
   - Treat the final database status, not the HTTP response code, as the source of truth.
3. **Chat**
   - Generate a UUID.
   - `POST /api/chats/stream` (or through the `/api/chat-stream` Next.js proxy) with:
     - a question relevant to the ingested document
     - the UUID in the `X-Request-Id` header
   - Treat this UUID as the canonical `request_id` when verifying `chat_histories` and `chat_details`.
4. **Read the SSE stream**: Confirm that:
   - every SSE event is valid JSON
   - each event contains exactly one workflow node
   - the workflow order is correct
   - no unexpected error or malformed event is received
   - a final answer is emitted
   - the final grade is one of:
     - `useful`
     - `useless`
     - `hallucination`
   - the stream closes normally after the workflow completes

5. **Confirm persistence**: one `chat_histories` row keyed by `request_id` (final answer, final grade, retry_count), and one `chat_details` row per attempt (queries, retrieved documents, answer, grade, feedback).

## Edge case to explicitly exercise: retry / hallucination path

Ask something not covered by the ingested document to force a `useless` or `hallucination` grade. This should trigger `decide_to_finish` → `retry` → a second `generate_queries_node` pass (previous feedback interpolated into
the prompt) → either `finish` or, once `retry_count == 1`, `force_finish` → `analyze_failure_node`.

Confirm:

- `retry_count` reaches `1`.
- On the forced-finish path, `chat_details.failure_analysis` is populated.
- If the change touched `src/backend/services/rag/nodes.py`, double-check any new state read uses `state["field"][-1]` (latest attempt) vs.
  `state["field"][0]` (initial attempt) correctly — see `src/backend/services/rag/CLAUDE.md` for the accumulation contract. This is the easiest bug class to introduce in this pipeline, and it won't be caught by type checking.

## Automated check: pytest

`docker compose exec -e PYTHONPATH=. backend poetry run pytest` runs `tests/test_documents.py` and `tests/test_chats.py`, which automate most of the golden path above (ingest → chat → grade), including the retry/`useless`-grade edge case. The same suite also runs in CI (`backend.yml`) on every PR touching `src/backend/**`. Reach for it first after touching `services/rag/{nodes,chains,prompts,workflows}.py` or the `documents`/`chats` endpoints — it's faster than the manual walk-through, but it's a complement, not a replacement:

- It runs inside the `backend` container because it needs the Compose network and the injected environment; see the `ci-check` skill for why the bare `poetry run pytest` fails on the host.
- It builds its own in-process app (`ASGITransport`) with its own temp Chroma dir, hitting a separate `<MYSQL_DATABASE>_test` database — it does **not** exercise the running docker compose containers, the Next.js `/api/chat-stream` SSE proxy, or the UI.
- Nothing is mocked — it needs real `OPENAI_API_KEY` / `COHERE_API_KEY`, same as the running app.
- The `<MYSQL_DATABASE>_test` DB is created by `init_db.py`, which already runs on backend container startup (i.e. it exists once the `run` skill has brought the stack up at least once), or run `poetry run python init_db.py` manually.
- It does not assert `retry_count == 1` or that `chat_details.failure_analysis` was populated — the manual edge-case check above still needs to confirm those.

## Frontend

There is no automated frontend test framework (no jest/vitest/playwright) — this step is manual/visual: confirm `ChatConsole.tsx` renders SSE workflow progress and the final answer as expected.

## Report

State exactly which steps passed, with the `request_id` and `doc_id` used, so the result is reproducible.
