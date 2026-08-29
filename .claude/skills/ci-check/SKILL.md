---
name: ci-check
description: Run the same checks as GitHub Actions CI locally for ai_app before pushing or opening a PR - backend Ruff lint/format and pytest, frontend ESLint and Prettier. Use before creating a PR, before pushing, or when asked to run CI checks locally or explain why CI failed.
---

# Local CI parity checks

Reproduce the PR CI (`backend.yml`, `frontend.yml`) locally so failures surface before pushing.

## Which checks to run

CI is path-filtered. Run only the suites whose paths the change touches:

- `src/backend/**` (or `.github/workflows/backend.yml`) → backend checks
- `src/frontend/**` (or `.github/workflows/frontend.yml`) → frontend checks
- `cdk/**` → **no PR CI exists**, and `npm test` proves nothing. `npm run diff` is the only safety signal (see the `cdk-deploy` skill).

## Backend (mirrors `backend.yml`)

From `src/backend/`, in CI order:

```bash
poetry run ruff check .
poetry run ruff format --check .
poetry run pytest
```

Fix format failures with `poetry run ruff format .` (without `--check`).

pytest prerequisites are listed in the `verify` skill's pytest section — real API keys,
a reachable `<MYSQL_DATABASE>_test` database. Check them there before running.

Tests make live OpenAI/Cohere calls, so they take a while and cost tokens. If only docs
or non-Python files changed, lint alone is enough.

## Frontend (mirrors `frontend.yml`)

From `src/frontend/`:

```bash
npm run lint
npm run format:check
```

Fix Prettier failures with `npx prettier --write .`.

CI runs no typecheck or unit tests (no such scripts exist). `npx tsc --noEmit` is a worthwhile optional extra check, but its failures do not block CI.

## Report

State which suites ran, which were skipped (and why — path filter), and each command's pass/fail with the failing output.
