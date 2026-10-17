# Agent Channels

## Supported Channels

Web, QQ, WeChat, Feishu, Telegram, and scheduled jobs use different transport and presentation adapters but share sessions, context assembly, Agent Runs, tools, interactions, and canonical history.

## Telegram

Telegram uses the Bot API long-polling Gateway and shares the same Agent Loop, identity checks, sessions, and tool permissions as other channels. It supports direct and group chats, text, files, inline keyboard interactions, and live draft previews in direct chats. Group delivery and available updates remain subject to the bot's Telegram privacy settings and platform rules.

## Mermaid Diagrams

The Web chat and Markdown file viewer render Mermaid code blocks as interactive diagrams with zoom, expanded viewing, and PNG export. IM replies on QQ, WeChat, Feishu, and Telegram render complete Mermaid blocks as PNG and preserve their order relative to surrounding text. Feishu can place diagrams in cards; other channels deliver adjacent image messages. Rendering failures preserve a readable text fallback and do not fail the ordinary reply. See the [Mermaid rendering PRD](../../prds/【已完成】PRD-MERMAID-1-统一Mermaid渲染与跨端PNG输出.md) for implementation constraints and acceptance criteria.

## Adapter Responsibilities

A channel adapter normalizes platform text, attachments, quotes, identity, group metadata, and external session identifiers. It converts canonical Agent events into platform messages. It must not reimplement context assembly, capability authorization, tool execution, or Run semantics.

Web streaming, IM delivery, and scheduled notifications may expose different event shapes, but they must preserve canonical event identity and terminal status.

## Identity and Ownership

Bind external identities to the correct user and conversation before loading context. Group permissions and cancellation rights are checked against the initiating actor. Cross-user data access always goes through ownership checks.

## Delivery and Recovery

Transport disconnects, duplicate delivery, reconnects, and platform rate limits are handled by the adapter or queue boundary. Canonical history and persisted Run state remain authoritative. A delivery retry must not execute a non-idempotent tool again.

Credentials are injected through protected configuration or environment boundaries and must not appear in argv, URLs, traces, or ordinary logs.
