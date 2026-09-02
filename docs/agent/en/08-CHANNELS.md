# Agent Channels

## Supported Channels

Web, QQ, WeChat, Feishu, and scheduled jobs use different transport and presentation adapters but share sessions, context assembly, Agent Runs, tools, interactions, and canonical history.

## Adapter Responsibilities

A channel adapter normalizes platform text, attachments, quotes, identity, group metadata, and external session identifiers. It converts canonical Agent events into platform messages. It must not reimplement context assembly, capability authorization, tool execution, or Run semantics.

Web streaming, IM delivery, and scheduled notifications may expose different event shapes, but they must preserve canonical event identity and terminal status.

## Identity and Ownership

Bind external identities to the correct user and conversation before loading context. Group permissions and cancellation rights are checked against the initiating actor. Cross-user data access always goes through ownership checks.

## Delivery and Recovery

Transport disconnects, duplicate delivery, reconnects, and platform rate limits are handled by the adapter or queue boundary. Canonical history and persisted Run state remain authoritative. A delivery retry must not execute a non-idempotent tool again.

Credentials are injected through protected configuration or environment boundaries and must not appear in argv, URLs, traces, or ordinary logs.
