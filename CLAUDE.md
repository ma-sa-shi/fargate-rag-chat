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
  → FastAPI POST /api/documents/{id}/embeddings
  → splits text → OpenAI embeddings → stored in Chroma
  → updates MySQL (status: ingested)
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

- `app/` — Next.js App Router pages and API routes
- `app/api/chat-stream/route.ts` — proxies SSE from FastAPI to browser
- `app/actions/` — Server Actions for auth and file uploads
- `components/features/rag/` — `ChatConsole.tsx` (SSE consumer, renders workflow progress in real-time), `ChatHistory.tsx` (client-side history list with filters)
- `lib/` — utilities: `auth.ts` (JWT), `db.ts` (MySQL for Server Actions), `file.ts` (S3), `chat.ts` (history queries), `chatFilter.ts` (history filtering), `env.ts`, `logger.ts`

### Backend Structure (`src/backend/`)

- `main.py` — FastAPI app; initializes MySQL pool, Chroma client, Cohere reranker via lifespan
- `api/endpoints/` — `chats.py` (streaming), `documents.py` (ingestion), `deps.py` (DI)
- `services/rag/` — LangGraph workflow (see above)
- `core/chroma.py` — document chunking (500 chars / 50 overlap) → OpenAI embeddings → Chroma
- `tests/` — Pytest integration tests for chat/document APIs
- `init_db.py` — creates tables: `users`, `docs`, `chat_histories`, `chat_details`
- `config.py` — Pydantic settings (env vars)

### AWS Infrastructure (`cdk/`)

Six CDK stacks in `cdk/lib/`. Dependency-driven order: `VpcStack` first (everything else needs its VPC) → `EfsStack`/`RdsStack`/`S3Stack` (each only depends on the VPC) → `EcsStack` last (depends on all three). `IamStack` has no dependency on any other stack and may deploy at any point in the dependency graph.

- **ECS Fargate**: backend (port 8000) + frontend (port 3000), Fargate SPOT
- **Cloudflare Tunnel**: sidecar container exposes the frontend
- **EFS**: access point rooted at `/chroma` (UID 1000), mounted at `/data` inside the backend container; Chroma persists to `/data/chromadb` (`PERSIST_DIRECTORY`)
- **RDS MySQL 8.4**: isolated subnet, credentials in Secrets Manager
- **GitHub OIDC**: `IamStack` provisions the OIDC provider for CI/CD assume-role

### Environment Variables

Both services share a single `.env` at repo root for local Docker Compose. Key variables:
- `OPENAI_API_KEY`, `COHERE_API_KEY` — LLM/reranking
- `JWT_SECRET` — token signing
- `MYSQL_*` / `DATABASE_URL` — database connection
- `FASTAPI_URL` — backend URL used by Next.js Server Actions (default: `http://backend:8000/api`)
- `PERSIST_DIRECTORY` — Chroma persistence path (`./chroma_db` locally, EFS-backed in production)

In production, secrets are injected from AWS SSM Parameter Store into ECS task definitions.

Copy `.env.example` to `.env` and fill in real values for local development.

## Documentation (`docs/`)

- `docs/adr/` — Architecture Decision Records (`001-compute-architecture.md`). Record significant architecture or infrastructure decisions as a new numbered ADR here, not only in the PR description.
- `docs/diagrams/` — `architecture.drawio` is the source (draw.io, 4 pages); each page is exported as an SVG alongside it. Edit the `.drawio` and re-export the SVGs; never edit an SVG directly.

## Common Commands

Backend (`src/backend/`, Poetry):
- `poetry run pytest` — integration tests (needs real API keys and the `<MYSQL_DATABASE>_test` DB; see the `verify` skill)
- `poetry run ruff check .` / `poetry run ruff format --check .` — lint / format check

Frontend (`src/frontend/`, npm):
- `npm run lint` — ESLint
- `npm run format:check` — Prettier
- No `typecheck` or `test` script exists (no jest/vitest/playwright).

CI (GitHub Actions): PRs to `main` run `backend.yml` (Ruff + pytest with a MySQL service) and `frontend.yml` (ESLint + Prettier), path-filtered to `src/backend/**` / `src/frontend/**`. All deploy workflows are manual (`workflow_dispatch`).

## Git and PR Conventions

- Branch names are `<type>/<kebab-slug>` (e.g. `fix/chat-stream-header-validation`, `docs/adr-001-compute-architecture`).
- Conventional Commits with a scope: `fix(backend):`, `docs(adr):`, `chore(cdk):`, `refactor(frontend):`. Scopes in use: `backend`, `frontend`, `cdk`, `ci`, `devcontainer`, `adr`, `claude`, `diagrams`.
- Commit messages are English: subject line, then one sentence stating what changed, then one bullet per change.
- Never add a `Co-Authored-By: Claude` trailer to a commit, or a Claude Code footer to a PR body.
- PR bodies are Japanese, structured as 概要 / 変更内容 / 影響 / 確認したこと / 残作業.
- `docs/issues/` holds Japanese drafts for GitHub Issues. It is gitignored — never commit it or cite it from a PR body; the user files the actual issue.
- Anything touching `src/`, `cdk/`, or `.github/` lands on `main` through a pull request — no direct pushes.
- Documentation-only changes that cannot affect the build may be committed to `main` directly: renames or moves with no content change, typo and wording fixes.
- Run the `ci-check` skill before opening a PR.

## Claude Code Skills

Project-specific skills in `.claude/skills/` (auto-invoked by description match):
- `run` — bring up the local stack correctly and check real readiness signals via the `/api/system/*` endpoints (`health`, `db-test`, `chroma-test`).
- `verify` — golden-path E2E check (upload → ingest → chat → SSE → persisted rows), including the retry/hallucination edge case.
- `cdk-deploy` — diff-before-deploy discipline and stack-order/destroy safety for `cdk/`.
- `ci-check` — run the same lint/format/test checks as CI locally before pushing or opening a PR.
