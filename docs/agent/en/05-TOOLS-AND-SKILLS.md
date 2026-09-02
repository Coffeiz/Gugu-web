# Tools and Skills

## Registry

Tools expose a name, short description, input schema, and execution contract. Skills describe methods and constraints; they do not grant new permissions. The model may see a capability summary first and request a full schema only when needed.

Registration, user settings, session state, platform restrictions, ownership checks, dispatch guards, and confirmation gates determine actual access. Prompt text cannot expand tool permissions.

## Tool Lifecycle

tool selection -> schema loading -> argument validation -> ownership and permission checks -> destructive confirmation when required -> execution -> canonical result -> history and channel event

Tool results must record success, failure, cancellation, timeout, and normalized output separately. A channel must not call a business service directly to fabricate a successful tool result.

## Skills

Skills are reusable instructions loaded within the current session lifecycle. They should explain when to use a capability, expected inputs, safety boundaries, and result handling. Secrets, credentials, and user-specific data do not belong in skill files.

## Adding a Capability

Update the registry, schema, permission filter, dispatch implementation, help/capability text, tests, and the relevant documentation together. Add failure, cancellation, duplicate-execution, ownership, and destructive-confirmation coverage.
