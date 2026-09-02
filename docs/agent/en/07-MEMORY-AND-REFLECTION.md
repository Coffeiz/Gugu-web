# Memory and Reflection

## Purpose

Memory preserves useful user-related long-term information. Knowledge preserves durable project, system, rule, and reference conclusions. Reflection evaluates recent conversation or task facts and decides whether a durable update is justified.

## Lifecycle

capture -> normalize -> ownership and scope checks -> deduplicate -> candidate memory/knowledge -> reflection decision -> persist or reject -> future context retrieval

A reflection task must not treat every conversation sentence as a fact. It should preserve uncertainty, source, time relevance, and user ownership. Sensitive credentials, transient secrets, and unverified guesses must not be stored.

## Reliability

Reflection is asynchronous and must not block the main answer unless explicitly required. Use scope locks, cursors, idempotency keys, retry limits, and compare-and-set writes. A failed reflection keeps the source facts and does not claim that a durable update succeeded.

Context injection remains subject to scope, confidence, and source filters. Deletion or forget operations must remove matching durable records and invalidate derived indexes safely.
