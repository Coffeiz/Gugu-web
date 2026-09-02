# i18n Directory and Writing Guide

This directory owns Gugu Web interface messages, locale registration, and localization tests. Components must read messages through `vue-i18n` and must not import a specific locale directly.

## Directory structure

```text
i18n/
├── locales/
│   ├── zh-CN.ts          # Simplified Chinese base messages
│   ├── ja-JP.ts          # Japanese base messages
│   └── en-US.ts          # English base messages
├── sections/
│   ├── profileTool.ts    # Profile tools and SMTP messages
│   ├── profileAccount.ts # Profile account settings
│   ├── canvas.ts         # Canvas messages
│   ├── adminAgent.ts     # Admin Agent messages
│   ├── common.ts         # Shared patches and compatibility additions
│   └── ...               # Other page or feature sections
├── messages.ts           # Composes all locale messages
├── registry.ts           # Single locale registry entry point
├── index.ts              # vue-i18n instance and locale APIs
├── types.ts              # Supported locales and locale options
└── *.test.ts             # i18n unit tests
```

## Writing rules

### Adding messages

1. Place copy in the owning `sections/<feature>.ts` file.
2. Add the same keys for `zh-CN`, `ja-JP`, and `en-US`.
3. Keep key names and nesting identical in every locale.
4. Keep `messages.ts` limited to importing, composing, patching, and typing messages.
5. Put shared copy and compatibility patches in `sections/common.ts` only when they have no single feature owner.

Use a language-grouped structure in a section:

```ts
export const exampleUi = {
  'zh-CN': { title: 'Example', save: 'Save' },
  'ja-JP': { title: 'Example', save: 'Save' },
  'en-US': { title: 'Example', save: 'Save' },
} as const
```

### Key naming

- Use stable, readable camelCase names such as `saveSuccess` and `smtpPasswordKeep`.
- Group keys by feature, for example `profileToolUi.smtpTest`.
- Do not use Chinese, pinyin, numeric ordering, or visual-position names.
- Reuse an existing key when the meaning and context are the same.
- Use vue-i18n interpolation instead of concatenating user input.

### Copy content

- Use Simplified Chinese for Chinese copy; write natural English and Japanese rather than literal translations.
- Preserve product names, API names, filenames, commands, and technical identifiers.
- Keep copy concise. Prefer verbs for buttons and only include necessary information in hints.
- Keep punctuation, spacing, capitalization, and line breaks natural for each locale.
- Never put secrets or real user data in messages.
- Do not embed HTML in messages; use controlled interpolation or the existing safe renderer.

### Component usage

Components, composables, and services use `$t` or `useI18n()`. Do not import `locales/*.ts` directly or hard-code user-facing copy in templates and scripts. Success, error, and confirmation messages must also use i18n.

## Validation

Run from `frontend/`:

```bash
npm run i18n:scan
npm run test:run -- src/i18n
npm run typecheck
npm run build
```

Before committing, verify that locale key sets match, no user-facing copy or incorrect locale paths remain, `messages.ts` is still an assembly module, and `git diff --check` passes.
