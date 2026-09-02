# Agent Message Protocol

## Canonical Events

Canonical history distinguishes user messages, assistant messages, tool calls, tool results, interaction requests, interaction actions, attachments, quotes, errors, and final status. Provider wire formats and channel display formats are adapters around these facts.

Every event needs stable identity, ordering, session/run association, and source metadata. Tool-call IDs and tool-result ownership must survive provider and channel conversion.

## Streaming

Streaming events may report run start, round start, text deltas, tool calls, tool results, interaction waits, progress, errors, and completion. Clients must tolerate reconnects and repeated delivery by using event identity and persisted status.

A browser disconnect does not automatically cancel a detached server generation. Resume reads the session stream and canonical history. A cancellation request must be authorized and idempotent.

## Attachments and Quotes

Attachments retain safe metadata, ownership, storage identity, and processing state. Quoted content retains source boundaries and must not be confused with the current user instruction. File names, credentials, and raw payloads are not written to visible logs.
