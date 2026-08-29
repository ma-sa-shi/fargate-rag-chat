# RAG pipeline (Self-RAG / LangGraph) — structural notes

This directory implements the Self-RAG workflow described in the root `CLAUDE.md`. The notes below describe the implementation contracts for this pipeline.

## State accumulation contract (`schemas.py`)

`GraphState` accumulates `queries`, `documents`, `answer`, `grade`, and `feedback` via `Annotated[..., operator.add]`.

Node return values must preserve the reducer types declared in `GraphState`. For accumulated fields, wrap each attempt's value in a single-element list (e.g. `{"queries": [queries]}`).

As a result:

- `state["queries"]` is `list[list[str]]` — one inner list per attempt.
- `state["documents"]` is `list[list[Document]]` — one inner list per attempt.
- `state["answer"]`, `state["grade"]`, and `state["feedback"]` are `list[str]` — one string per attempt.

Use `[-1]` for the current attempt and `[0]` for the initial attempt.
Mixing them up is the easiest bug to introduce when modifying this pipeline.

`retry_count` is the one exception — it's a plain `int`, not accumulated.

## Retry limit (`workflows.py`)

`decide_to_finish` routes based on the latest grade:
- `"useful"` → `finish` (END).
- `retry_count == 1` → `force_finish` → `analyze_failure_node` → END.
- otherwise → `retry` → back to `generate_queries_node`.

There is exactly **one** retry, ever. Raising this limit means changing the `retry_count == 1` check, not adding a new constant elsewhere.

## Retry feedback prefix (`nodes.py`)

`generate_queries_node` prepends the literal `フィードバック: ` to the previous attempt's feedback before it is interpolated into `{feedback}` in `generate_queries_prompt`. `prompts.py` holds only the placeholder — the prefix itself is built in `nodes.py`.

The same function logs `feedback[7:57]` to drop that prefix, and the offset is already two characters short of it. If you change the prefix, fix the slice in the log call as well.

## Chains (`chains.py`)

Four chains share a single `ChatOpenAI` model:
- `generate_queries_chain` and `grade_answer_chain` use `.with_structured_output()` against the Pydantic models `MultiQuery` and `GradeAnswer` (`schemas.py`).
- `generate_answer_chain` and `analyze_failure_chain` use `StrOutputParser()` (plain string output).

Changing a structured-output Pydantic model requires updating the corresponding prompt as well.

## Retrieval fusion (`utils.py`)

`reciprocal_rank_fusion` merges the per-query Chroma result lists in `retrieve_contexts_node` before the Cohere rerank. It scores by rank only (`1 / (rank + k)`, `k=60`) and keys on `Document.id`, so it depends on Chroma returning stable ids — it does not compare document text.

Its `top_n=20` default is the cutoff for what reaches the reranker, and it is applied at the call site by omission (`nodes.py` passes neither `k` nor `top_n`). Widening the candidate pool means changing the default here, not the retriever.

## Downstream persistence

`chat_details` persists one row per attempt, mirroring the accumulated state.
Changing a node's return shape affects persistence as well — check `services/rag/repository.py`'s `save_chat_result`.

## Verifying changes here

Run the `verify` skill (`.claude/skills/verify/SKILL.md`) after modifying this pipeline. It exercises both the normal path and the retry /
hallucination path.
