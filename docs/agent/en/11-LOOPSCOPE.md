# LoopScope Observability

LoopScope is a development and regression observability tool for Agent Runs. It records comparable Run, Round, Span, context provenance, provider usage, prefix changes, and code-location diagnostics without becoming a business source of truth.

## Boundary

Gugu Agent remains Python/FastAPI, Python workers, and Python IM gateways. The trace bridge sends controlled snapshots to the TypeScript Collector and SQLite-backed LoopScope UI. Collector, HTTP, or SQLite failure must never block replies, tool execution, persistence, or channel delivery.

## Model

Session -> Run -> context spans, LLM rounds, tool/guard spans, results, final output or error.

Useful diagnostics include context sources, message shapes, stable-prefix digests, first input change, cache anchors, tool schema digest, usage, duration, and provider capability. Digests are comparison fingerprints, not reversible content.

## Prefix Diff

Compare ordered provider input messages, ignoring object-key order but preserving array order. Report the earliest difference and classify wrapper, role, block shape, content kind, content, or message-count changes. Do not claim a comparison when inputs cannot be aligned.

## Privacy and Usage

Development traces may contain controlled input/output for diagnosis, but tokens, cookies, API keys, credentials, and ordinary visible logs must remain protected. LoopScope cannot execute tools or mutate Agent state.
