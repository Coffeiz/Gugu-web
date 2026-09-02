# Agent System Overview

Gugu Agent is the unified conversation execution layer. It accepts requests from Web, QQ, WeChat, Feishu, and scheduled jobs, loads user and session context, selects model capabilities, executes tools when needed, persists structured results, and returns channel-specific output.

The web UI and IM gateways are input/output adapters, not the Agent itself. Model providers are execution adapters. The Agent core owns context, tools, skills, task loops, interaction state, and persistence.

## Runtime Boundary

- Vue 3 and TypeScript provide the frontend and browser workflows.
- Python, FastAPI, SQLAlchemy, PostgreSQL, and Redis provide business APIs, persistence, workers, and orchestration.
- backend/agent owns routing, context, providers, tools, skills, memory, RAG, and interactions.
- TypeScript services provide the lexical RAG worker and LoopScope collector; they are not a complete TypeScript Agent backend.
- sandboxd and Docker enforce Shell execution boundaries, permissions, and quotas.

## Core Capabilities

A Run may contain multiple model Rounds, tool calls, tool results, retries, and user interactions. Tool calls require schema validation, permission checks, and confirmation where needed. Canonical history is the semantic source of truth; channels and providers only adapt its representation.

Snapshot, History, Memory, Knowledge, RAG, current messages, and capability metadata are assembled by one context pipeline. Memory stores user-related long-term information; Knowledge stores project, system, rule, and reference conclusions.

## High-Level Flow

channel input -> gateway/router -> conversation session -> context assembly -> RAG and capability filtering -> model round -> guarded tool execution or final response -> persistence -> channel output -> LoopScope and usage records

User ownership, dangerous-operation confirmation, sandbox scope, quotas, and system configuration are enforced by backend code, not by model instructions.
