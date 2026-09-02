# Agent System Architecture

## Principles

1. Keep channel adapters separate from Agent orchestration.
2. Treat canonical history as the semantic source of tool, interaction, and message facts.
3. Enforce permissions in backend code; prompts never grant capabilities.
4. Assemble Snapshot, History, RAG, Memory, Knowledge, and the current message in one context pipeline.
5. Keep confirmation UX separate from the real Shell, identity, network, and quota boundaries.

## Layers

Web / QQ / WeChat / Feishu / scheduled jobs
  -> Gateway / Router
  -> ConversationSession
  -> Agent orchestration: Run -> Round -> Tool loop
  -> Context / Capability / Provider
  -> business tools and sandboxd
  -> PostgreSQL / Redis / storage
  -> LoopScope / usage / audit

## Service Ownership

- gugu-backend provides FastAPI APIs and the Web Agent path.
- gugu-worker consumes IM messages and runs the shared Agent loop.
- gugu-gateway manages external gateway connections and processes.
- The TypeScript lexical worker provides RAG indexing and search.
- LoopScope collects development traces without blocking business requests.
- sandboxd executes Shell commands within the container and quota boundary.

## Module Boundaries

Gateway normalizes platform messages, attachments, identity, and sessions. Orchestration owns Run/Round lifecycle, tool loops, cancellation, retries, and persistence. Context owns context assembly and budget handling. Capability owns registration, filtering, schemas, and dispatch guards. Providers translate canonical context to vendor protocols and back.

RAG, Memory, and Knowledge return structured context to the Context layer and must not bypass ownership checks. Tool execution follows:

schema validation -> ownership/permission -> confirmation -> business service or sandboxd -> canonical result -> history and channel event

Components must not duplicate protocol, authentication, CSRF, client identity, or error conversion.
