/// <reference types="vite/client" />

// vite.config.js define 注入的构建版本号
declare const __APP_VERSION__: string
declare const __BUILTIN_SKILL_CARDS__: Record<string, { name: string; description: string } | undefined>
declare const __APP_RELEASE__: string
declare const __APP_BUILT_AT__: string
declare const __RUNTIME_VERSION__: string
