# Agent Documentation Index

This directory documents the current Gugu Agent architecture, execution paths, and engineering conventions. The Chinese documents remain the primary detailed references; this directory contains their English companions.

## Reading Order

1. 01-OVERVIEW.md: system purpose, scope, and major services.
2. 02-ARCHITECTURE.md: service layers, module boundaries, and data flow.
3. 03-AGENT-LOOP.md: Run, Round, tool calls, interactions, and guards.
4. 04-CONTEXT-ENGINEERING.md: context assembly, compression, and cache prefixes.
5. 05-TOOLS-AND-SKILLS.md: capability registry, schemas, skills, and dispatch.
6. 06-RAG-AND-KNOWLEDGE.md: retrieval, scopes, indexes, and injection.
7. 07-MEMORY-AND-REFLECTION.md: long-term memory and reflection lifecycle.
8. 08-CHANNELS.md: Web, QQ, WeChat, and Feishu adapters.
9. 09-MESSAGE-PROTOCOL.md: streaming events, tools, attachments, and history.
10. 10-RELIABILITY.md: retry, cancellation, concurrency, shutdown, and recovery.
11. 11-LOOPSCOPE.md: development observability and trace diagnosis.
12. COMMANDS.md: slash commands and session controls.

The English files are kept in sync with the current implementation. Historical proposals under ../_archive are excluded from the active documentation set.
