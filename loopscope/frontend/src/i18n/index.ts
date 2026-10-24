import { computed, ref } from 'vue'

export type Locale = 'zh-CN' | 'en-US'

const STORAGE_KEY = 'loopscope:locale'
let storedLocale: string | null = null
try {
  if (typeof localStorage !== 'undefined') storedLocale = localStorage.getItem(STORAGE_KEY)
} catch {
  // Storage may be unavailable in restricted browser contexts; in-memory locale still works.
}
const locale = ref<Locale>(storedLocale === 'en-US' ? 'en-US' : 'zh-CN')

import * as changelogMessages from './pages/changelog'
import * as commonMessages from './pages/common'
import * as monitorMessages from './pages/monitor'
import * as navigationMessages from './pages/navigation'
import * as playgroundMessages from './pages/playground'
import * as reflectionsMessages from './pages/reflections'
import * as settingsMessages from './pages/settings'
import * as tokensMessages from './pages/tokens'
import * as traceMessages from './pages/trace'

const messages: Record<string, string> = {
  ...changelogMessages.en,
  ...commonMessages.en,
  ...monitorMessages.en,
  ...navigationMessages.en,
  ...playgroundMessages.en,
  ...reflectionsMessages.en,
  ...settingsMessages.en,
  ...tokensMessages.en,
  ...traceMessages.en
}
const zhMessages: Record<string, string> = {
  ...changelogMessages.zh,
  ...commonMessages.zh,
  ...monitorMessages.zh,
  ...navigationMessages.zh,
  ...playgroundMessages.zh,
  ...reflectionsMessages.zh,
  ...settingsMessages.zh,
  ...tokensMessages.zh,
  ...traceMessages.zh
}

export function setLocale(value: Locale) {
  locale.value = value
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // Keep the current locale for this page even if it cannot be persisted.
  }
  if (typeof document !== 'undefined') document.documentElement.lang = value
}

if (typeof document !== 'undefined') document.documentElement.lang = locale.value

export function useLoopScopeI18n() {
  return {
    locale: computed(() => locale.value),
    t(key: string, values: Record<string, string | number> = {}) {
      let result = locale.value === 'en-US' ? messages[key] ?? key : zhMessages[key] ?? key
      for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value))
      return result
    },
  }
}
