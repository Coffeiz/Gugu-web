# Context Engineering

## Purpose

Context Engineering defines how Snapshot, History, Memory, Knowledge, RAG, capabilities, and the current message become one provider-neutral model input. Channels and providers must not assemble a second context.

## Context Layers

- Snapshot contains stable system, capability, and session state.
- History contains persisted user, assistant, tool, result, and interaction facts.
- Memory contains user-related long-term information.
- Knowledge contains project, system, rule, and reference conclusions.
- RAG provides scope-filtered candidates for the current request.
- The current message and current Run facts form the dynamic tail.

Stable prefixes should remain unchanged. Dynamic timestamps, random IDs, repeated reminders, unstable tool ordering, and accidental wrapper changes must not be inserted into the stable prefix.

## Budget and Compression

Measure context before provider conversion. Compress only eligible old history. Do not consume Snapshot, the current user message, active tool pairs, or required dynamic context. Write one baseline summary with compare-and-set semantics; an old compression result must not overwrite a newer baseline.

If compression fails, retain the original history and report a structured failure. Provider wire messages may differ, but canonical ordering, tool-call IDs, result ownership, quotes, and attachments must remain stable.

## Security

Context assembly enforces ownership and source scope. Internal diagnostics, credentials, and unauthorized records never become model context. Traces may show controlled development provenance but ordinary logs must remain redacted.
