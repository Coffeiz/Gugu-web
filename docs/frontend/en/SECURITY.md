# Frontend Security Guidelines

## Requests and Identity

- Route all ordinary API requests through frontend/src/services/api.ts. Do not duplicate authentication, CSRF, or error parsing in pages.
- User requests use user_token; administrative requests use a separate admin_token. Tokens must not appear in URLs, visible logs, error messages, or commits.
- Unsafe methods automatically carry X-CSRF-Token. Write requests carry the current tab's X-Client-Id for Live echo detection.
- The server is the authority for authorization. Frontend route guards and hidden buttons are user experience only, not data boundaries.
- The request layer owns 401 cleanup and login redirection. Components must not copy this behavior.

## HTML, Markdown, and Links

- v-html may only receive sanitized output from frontend/src/utils/markdown.ts.
- Markdown must pass through DOMPurify. Never write user input, server-returned HTML, or streamed HTML directly into the DOM.
- Normal Markdown allows only safe URL protocols. gugu:// action links are allowed only through sanitizeChatHtml and a controlled action matcher.
- External links use target=_blank and rel=noopener noreferrer. Do not concatenate unescaped href, title, or HTML attributes.
- Mermaid, syntax highlighting, and task lists may use specialized dynamic DOM, but must preserve the existing sanitization and event-delegation boundaries.

## Secrets and Sensitive Data

- Passwords, API keys, SMTP passwords, binding codes, and uploaded files exist only for the required form or request lifetime. Never write them to localStorage, logs, URLs, or Git.
- BYOK, SMTP, password changes, avatar uploads, and similar actions use explicit save and server confirmation. Do not optimistically display or auto-fill secret values.
- User input and attachment names must not enter visible diagnostic logs. Use fingerprint or the existing redaction utilities when correlation is needed.
- Visible errors contain only server-approved information. Raw exceptions go only to the controlled diagnostic channel.

## Destructive Operations and Component Boundaries

- Delete, reset, overwrite, disable, clear-data, and account-logout actions must use useConfirmDialog / ConfirmDialog.
- Native alert, confirm, and prompt calls are prohibited in Vue source.
- Shared components must not use private page selectors for authorization or security decisions.
- New external requests, rich-text behavior, or credential fields require protocol allowlists, input boundaries, and failure-path tests.
