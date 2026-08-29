# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RAG-based internal knowledge search platform. Users upload documents → embeddings stored in Chroma → SSE-streamed Q&A via a Self-RAG (LangGraph) pipeline.

Stack: Next.js 16 frontend, FastAPI backend, MySQL 8.4, Chroma vector DB, deployed on AWS ECS Fargate via CDK.

Use the `run` and `verify` Skills for local startup and end-to-end verification.

This project uses a single AWS account and region. There is no dev/prod split.

See `cdk/README.md` for CDK architecture and `.claude/skills/cdk-deploy/` for deployment safety rules.

## Architecture

### Request Flow

**Chat (SSE streaming)**:
```
Browser → Next.js Route Handler (/api/chat-stream)
  → validates JWT cookie → adds X-User-Id / X-Request-Id headers
  → FastAPI POST /api/chats/stream
  → LangGraph workflow (StateGraph) streams updates
  → Browser parses SSE events and updates UI in real-time
  → Final state saved to MySQL (chat_histories + chat_details)
```

**Document ingestion**:
```
Browser → Next.js Server Action (file-actions.ts)
  → uploads file, extracts text, saves to MySQL (status: uploaded)
  → marks the row `processing`, then FastAPI POST /api/documents/{id}/embeddings
  → splits text → OpenAI embeddings → stored in Chroma
  → updates MySQL (status: ingested, or failed)
```

**Auth**: Server Actions validate credentials against MySQL, hash passwords with argon2, issue JWT set in an httpOnly `session_token` cookie. `getUserIdFromToken()` in `lib/auth.ts` guards every protected page.

### LangGraph Self-RAG Workflow (`src/backend/services/rag/`)

```
generate_queries_node   → multi-query generation (LLM)
retrieve_contexts_node  → Chroma retrieval + RRF fusion + Cohere rerank
generate_answer_node    → LLM answer generation
grade_answer_node       → evaluate: "useful" | "useless" | "hallucination"
  ├─ useful → END
  ├─ retry_count < 1 → back to generate_queries_node (with feedback)
  └─ retry_count >= 1 → analyze_failure_node → END
```

Key files: `workflows.py` (StateGraph), `nodes.py` (node implementations), `chains.py` (LLM chains), `prompts.py` (Japanese prompts), `schemas.py` (`GraphState` + structured-output models), `utils.py` (RRF fusion), `repository.py` (persistence).

See `src/backend/services/rag/CLAUDE.md` for the state-accumulation contract (retry history is appended, not overwritten — nodes must index `[-1]`/`[0]` correctly) and other non-obvious details of this pipeline.

### Frontend Structure (`src/frontend/`)

- `app/api/chat-stream/route.ts` — validates the JWT cookie, then proxies the SSE stream
  from FastAPI straight through to the browser.
- `app/actions/` — Server Actions for auth and file upload. They reach MySQL and S3
  directly, so the frontend is not a pure BFF over FastAPI.
- `components/features/rag/ChatConsole.tsx` — consumes the SSE stream and renders each
  workflow node's progress live.
- `lib/` — `auth.ts` (JWT), `db.ts` (MySQL pool for Server Actions), `file.ts` (S3 +
  the ingest call), `chat.ts` / `chatFilter.ts` (history).

### Backend Structure (`src/backend/`)

- `main.py` — FastAPI app. The lifespan handler builds the MySQL pool, Chroma client, and
  Cohere reranker on `app.state`. `chats.py` hands the retriever and reranker to the RAG
  nodes through `RunnableConfig`; the pool reaches persistence through the `Request` object.
- `api/endpoints/` — `chats.py` (SSE streaming), `documents.py` (ingestion), `system.py`
  (`health` / `db-test` / `chroma-test`, used by the `run` skill), `deps.py` (DI). A new
  endpoint is only reachable once its router is registered in `api.py`.
- `services/rag/` — the LangGraph workflow (see above).
- `core/chroma.py` — chunking (500 chars / 50 overlap) → OpenAI embeddings → Chroma.
- `init_db.py` — connects as the MySQL master user and creates the `<MYSQL_DATABASE>` and
  `<MYSQL_DATABASE>_test` databases, the application user and its grants, and the `users`,
  `docs`, `chat_histories`, `chat_details` tables. It runs on every backend start,
  production included — the deploy workflow puts it in front of `uvicorn`.

### AWS Infrastructure (`cdk/`)

Six CDK stacks in `cdk/lib/`; see `cdk/README.md` for the stack graph and what each one
provisions, and `cdk/CLAUDE.md` before editing anything under `cdk/`. Two facts matter
outside infrastructure work:

- Chroma persists to `/data/chromadb` on EFS in production (`PERSIST_DIRECTORY`), so
  vector data survives task replacement but is not shared with your local `./chroma_db`.
- Both services run Mon–Fri 09:00–19:00 JST on scheduled auto scaling and are scaled to
  zero outside that window, so a deployed environment is normally down at night.

### Environment Variables

Backend, frontend, and MySQL share a single `.env` at the repo root. Copy `.env.example`
to `.env` and fill in real values — that file documents every variable. Backend settings
are typed in `src/backend/config.py`. In production these come from SSM Parameter Store
and Secrets Manager instead, injected into the ECS task definitions.

## Documentation

Docs are split by audience, and the language follows the split:

- **For people, in Japanese** — `README.md`, `docs/**`, `cdk/README.md`, `.env.example`.
  These own the facts: what exists, and why it was chosen.
- **For Claude, in English** — every `CLAUDE.md` and `.claude/skills/**`. These own the
  contracts that are easy to break while editing, and the procedures to run.

Japanese prose in the human-facing files uses connectives — `そのため`, `一方`, `ただし`,
`また`, `そこで` — so a section reads as a connected argument rather than a list of
juxtaposed facts. Half-width brackets, and `ため` rather than `為`.

Keep each fact in one place. When a skill or a `CLAUDE.md` needs a fact a human-facing
doc already states, link to it rather than restating it — the restatement is what goes
stale.

- Record significant architecture or infrastructure decisions as a new numbered ADR in
  `docs/adr/`, not only in the PR description.
- `docs/diagrams/architecture.drawio` is the source of truth for the diagrams. Edit it and
  re-export the SVGs beside it; never edit an SVG directly.

## Common Commands

Backend (`src/backend/`, Poetry):
- `docker compose exec -e PYTHONPATH=. backend poetry run pytest` — integration tests. They
  need the Compose network and real API keys, so the bare `poetry run pytest` fails on the
  host; see the `ci-check` skill
- `poetry run ruff check .` / `poetry run ruff format --check .` — lint / format check

Frontend (`src/frontend/`, npm):
- `npm run lint` — ESLint
- `npm run format:check` — Prettier
- There is no `typecheck` or `test` script — do not assume one exists.

CI runs these same checks on PRs to `main`, path-filtered per service; every deploy
workflow is manual. Use the `ci-check` skill to reproduce CI locally.

## Git and PR Conventions

- Branch names are `<type>/<kebab-slug>` (e.g. `fix/chat-stream-header-validation`, `docs/adr-001-compute-architecture`).
- Conventional Commits with a scope: `fix(backend):`, `docs(adr):`, `chore(cdk):`, `refactor(frontend):`.
- Commit messages are English: subject line, then one sentence stating what changed, then one bullet per change.
- Never add a `Co-Authored-By: Claude` trailer to a commit, or a Claude Code footer to a PR body.
- PR bodies are Japanese, structured as 概要 / 変更内容 / 影響 / 確認したこと / 残作業.
- `docs/issues/` holds Japanese drafts for GitHub Issues. It is gitignored — never commit it or cite it from a PR body; the user files the actual issue.
- Anything touching `src/`, `cdk/`, or `.github/` lands on `main` through a pull request — no direct pushes.
- Documentation-only changes that cannot affect the build may be committed to `main` directly: renames or moves with no content change, typo and wording fixes.
- Run the `ci-check` skill before opening a PR.

## Claude Code Skills

Project-specific skills in `.claude/skills/`, auto-invoked by description match:

- `run` — start the local stack and verify readiness.
- `verify` — run the golden-path E2E flow.
- `cdk-deploy` — safely diff and deploy CDK stacks.
- `ci-check` — run the same checks as CI locally.
