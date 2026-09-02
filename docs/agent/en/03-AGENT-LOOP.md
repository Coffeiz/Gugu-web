# Agent Loop

## Execution Model

- Run is one complete request or resumed task, including context, usage, final state, and diagnostics.
- Round is one model request and response.
- Tool Call is a model-declared operation that still requires schema, permission, and confirmation checks.
- Interaction is a persisted wait state for user confirmation, selection, or missing information.

## Sequence

channel request -> normalize request -> load session and context -> enforce context budget -> start Run -> start Round -> call provider -> guard output -> persist text or execute guarded tools -> continue or pause -> persist final state -> adapt and send channel output

A Run may contain several Rounds. A paused Interaction resumes the same Run/session; it must not create an unrelated conversation.

## Guards

Context guards protect budget and compression boundaries. Output guards distinguish text, tool calls, interaction requests, errors, retryable errors, and cancellation. Tool guards validate schema, permissions, ownership, destructive confirmation, and sandbox scope. Progress guards decide whether another Round is allowed. Final-output guards ensure one coherent terminal state.

## Tool and Interaction Rules

Every tool call receives a canonical event and result. Invalid arguments become structured tool errors. Destructive actions pause for confirmation. Confirmation actions are one-shot and must be bound to the originating session and user. A failed tool must not be presented as success.

Cancellation stops active work, prevents later rounds, and preserves a structured cancelled state. Retries are finite and must not duplicate non-idempotent side effects.

## Completion

The terminal state is persisted before channel delivery. Channel delivery may retry independently, while canonical history remains the source of truth. Diagnostics and usage are recorded without blocking the user response.
