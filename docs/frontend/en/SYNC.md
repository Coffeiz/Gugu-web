# Frontend Interaction Sync Guidelines

## Purpose

Use one model for immediate local feedback, server persistence, failure rollback, and multi-client events. Pages must not maintain separate optimistic-update and refresh-suppression implementations.

The shared entry point is frontend/src/interaction/sync/InteractionSync.ts. Business code supplies apply, rollback, and request behavior. InteractionSync owns mutation identity, client identity, and intent lifecycle.

## When to Use It

Use InteractionSync for:

- Single-value toggles, single-value choices, and frequent drag moves.
- Actions whose result is immediately visible and whose previous value is known for rollback.
- Ordinary state that may be changed by another browser tab or client.

Examples include mail subscription, timezone, default page, calendar display, Shell preferences, Gugu display preferences, file moves, canvas node moves, and calendar event changes.

Do not use it for:

- Passwords, API keys, SMTP passwords, or other secrets.
- Avatar/file uploads or operations with upload or parsing stages.
- Draft state for multi-field forms; submit the whole form explicitly.
- Account deletion, data clearing, capability disabling, or other destructive actions.
- Purely local theme, palette, and language changes unless they also require server-side cross-client synchronization.

These cases keep local form state, explicit save, confirmation, or server-confirmed updates.

## Standard Sequence

```text
capture previous value
  -> InteractionSync.execute
  -> apply local state immediately
  -> send server request
  -> accept normalized server snapshot on success
  -> rollback previous value on failure
```

Repeated operations must use a stable entityKey. A failed older intent must never roll back a newer intent. Do not immediately perform an unconditional full refresh after success; reconcile with version or intent checks.

## Live Events

Server events must carry the originating client identity. Events originating from the current client must not overwrite its pending optimistic state. Events from another client or browser tab must enter normal reconciliation.

Optimistic UI is not Live synchronization by itself. Verify both event delivery and source-echo suppression.

## Failure Handling

- apply and rollback must target the same state source.
- Capture the rollback snapshot before apply.
- An older intent must not overwrite a newer local intent when it fails.
- Use the existing lightweight error feedback for ordinary settings; preserve explicit error states for sensitive forms and uploads.
- Do not hide races with delays, extra nextTick calls, repeated refreshes, or CSS patches.

## Review Checklist

- Is this an immediate single-value action or an explicitly saved form?
- Are scope and entityKey stable and sufficiently specific?
- Is there a pre-apply snapshot and a symmetric rollback?
- Can an old request or Live echo overwrite newer local state?
- Has a secret, upload, or destructive action been made optimistic by mistake?
- Does the normalized server response become the final local state?
- Are repeated clicks, rollback, and cross-client events tested?
