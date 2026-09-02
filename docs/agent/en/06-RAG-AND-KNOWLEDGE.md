# RAG and Knowledge

## Roles

- RAG retrieves scope-filtered candidates for the current request.
- Memory stores user-related long-term information.
- Knowledge stores project, system, rule, process, and reference conclusions.

These systems provide structured context to Context Assembly. They do not bypass authorization or directly rewrite the user message.

## Retrieval Pipeline

source and scope filtering -> document projection -> lexical index lookup -> candidate ranking -> confidence and diversity filters -> context injection

The TypeScript lexical worker supplies persistent indexing and search support. Index versions, scope digests, cache state, candidate counts, accepted/rejected counts, confidence thresholds, and timing belong to diagnostics.

No-hit, low-confidence, unauthorized, duplicate, or stale candidates must not be injected as facts. A disabled or unavailable index must produce an explicit fallback or retryable state, not a false success.

## Updates

Document writes, index patches, scope changes, and cleanup use versions, cursors, locks, or idempotency keys. Background indexing and reflection must not block an unrelated user response. Garbage collection may remove only confirmed derived artifacts, never business source data.
