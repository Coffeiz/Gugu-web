# Agent Reliability

## Required Guarantees

- At-least-once queues require deduplication and idempotent side effects.
- Session execution uses locks or gates to prevent conflicting Runs.
- Retries are finite, classified, and bounded by backoff.
- Cancellation, timeout, and shutdown produce explicit terminal states.
- Background failures do not silently claim success.

## Queues and Workers

Track stream length, pending entries, lag, consumers, claims, receive-to-ack latency, failure class, and retry count. On shutdown, stop accepting new work, drain active dispatches and flush tasks, close schedulers and connections, and release locks.

## Compaction and Background Work

Compression uses a baseline version or hash compare-and-set. If the baseline changed, an older result is discarded. RAG indexing, reflection, cleanup, scheduled jobs, and title generation require cursors, locks, versions, or idempotency keys.

## Diagnostics

Use redacted IDs, counts, states, durations, and fingerprints. Never put user content, attachment names, secrets, API keys, or provider credentials into ordinary logs. Reliability tests cover success, transient failure, permanent failure, duplication, cancellation, timeout, and process restart.
