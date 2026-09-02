# Frontend Architecture Guidelines

## Startup and Routing

- frontend/src/main.ts owns version gating, theme, button feedback, Runtime, Pinia, i18n, router, and shared component registration order.
- router/index.ts owns routes, authentication, and page-level access prerequisites. Pages must not duplicate global login redirects.
- layouts own the application shell. views own page composition and flow coordination. Complex entry points move state and requests into composables or services.

## Layer Responsibilities

```text
views / components
        ↓
business composables
        ↓
stores / interaction adapters
        ↓
services / api / utils
```

- Shared components own templates, styles, DOM interaction, and presentation state. They must not depend on page entry points or private routes.
- composables own Vue lifecycle, local state, async flows, and business orchestration. Pure calculations belong in utils.
- stores own state shared across components/pages and coordinate API, Live, cache, and rollback. Do not maintain the same server entity independently in several pages.
- services/api.ts is the request protocol boundary. Components must not duplicate paths, auth, CSRF, client identity, or common error conversion.
- Register user-facing i18n text through frontend/src/i18n/sections/. Components must not add hard-coded visible copy.

## InteractionSync and Runtime

- Immediate single-value preferences, frequent drags, and clearly reversible actions use InteractionSync.execute with apply, rollback, and request supplied by the caller.
- Passwords, credentials, uploads, multi-field explicit saves, and destructive actions retain server-confirmed semantics.
- Live events use X-Client-Id and origin for same-client echo suppression. Other-client events reconcile without unconditionally replacing pending local intent.
- Runtime owns dragging, landing, proxy, surface, and lifecycle visual state. Business code registers objects/surfaces and provides persistence, permission, and entity mapping through adapters.
- Runtime-managed nodes must not have their phase inferred, mouseenter synthesized, or opacity/transform controlled a second time by business code. For flicker, inspect node identity, refresh, and event races first.

## State and Requests

- Separate read state, write state, optimistic apply, server confirmation, and failure rollback.
- Repeated writes use stable scope/entityKey or an equivalent intent key. An old failure must not roll back a newer local intent.
- When the server returns normalized fields, converge to that snapshot. Do not let a possibly stale full GET overwrite a later local action.
- Unmount must clean listeners, timers, observers, polling, Teleport roots, and unfinished UI work.
