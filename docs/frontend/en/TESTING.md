# Frontend Testing Guidelines

## Test Layers

- Test pure functions, stores, composables, InteractionSync, and race logic in frontend/src/**.test.ts or frontend/test/ with Vitest.
- Test global styles, theme tokens, shared component structure, and style owners with frontend/src/assets/styles/*regression.test.ts or the existing CSS checks.
- Test cross-component page flows with Playwright under frontend/e2e/. Stable primary paths belong to test:e2e:stable; drag and experimental flows belong to test:e2e:experimental.
- E2E uses an already running devserver by default. Change the environment with PLAYWRIGHT_BASE_URL instead of starting another frontend/backend inside the test.

## Common Commands

```bash
cd frontend
npm run typecheck
npm run typecheck:strict
npm run test:run
npm run test:css-glass
npm run test:ui-dialogs
npm run build
npm run test:e2e:stable
```

Run the smallest set for the changed area, but always run typecheck before commit. Shared component, theme, and sync changes require the relevant regression tests.

## Required Contracts

- InteractionSync: immediate apply, success convergence, failure rollback, protection from stale failures, and no duplicate refresh from same-client Live echoes.
- Forms and shared controls: props/emits, keyboard focus, disabled, light/dark themes, selected/hover states, and cancellation paths.
- Runtime interaction: drag landing, proxy/target handoff, surface registration, stable node identity, and no duplicate hover or opacity 1 -> 0 -> 1 flash while the pointer remains on the card.
- Markdown and links: reject dangerous protocols, sanitize HTML, and route gugu:// actions only through the controlled dispatcher.
- Localization: Chinese, Japanese, and English must not overflow. New copy must be registered through the i18n registry and pass completeness checks.

## Browser Acceptance

- Browser comments and screenshots are investigation clues. Final validation must inspect the actual DOM, computed styles, and interaction result.
- Check both light and dark themes. For drag, Teleport, or animation changes, check pointer retention, rapid repeated actions, and failure rollback.
- Performance traces, console probes, and temporary diagnostics are for investigation only and must be removed before commit.
- Failed-test test-results/, traces, and screenshots are diagnostic artifacts and must not be added to product commits.

## CI Language Convention

- Playwright E2E in CI uses Simplified Chinese as the default locale (`zh-CN`) and explicitly sets the test user's language preference. The main flow must not depend on the browser or devserver system language.
- Prefer stable `data-testid`, role, aria-label, form name, and URL selectors. Do not use visible Chinese copy as the only selector.
- When text must be asserted, the main CI flow asserts Chinese resources. English and Japanese run in a separate locale matrix or smoke suite instead of sharing fragile text selectors.
- For every new page, component, or visible string, make the `zh-CN` E2E path pass first, then add overflow, missing-translation, and critical-path checks for other locales.
- Test fixtures, seed data, snapshot titles, and test-user-visible content use Chinese consistently and must not depend on a real user's language preference.
