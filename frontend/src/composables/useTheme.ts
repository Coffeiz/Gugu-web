import { computed, ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type ThemeFamily = 'glass' | 'v2'

const preference = ref<ThemePreference>(readPreference())
const resolved = ref<ResolvedTheme>(resolve(preference.value))
const family = ref<ThemeFamily>(readFamily())
let mediaQuery: MediaQueryList | null = null

function readPreference(): ThemePreference {
  const value = localStorage.getItem('gugu-theme')
  return value === 'dark' || value === 'system' ? value : 'light'
}

function readFamily(): ThemeFamily {
  return localStorage.getItem('gugu-theme-family') === 'v2' ? 'v2' : 'glass'
}

function resolve(value: ThemePreference): ResolvedTheme {
  if (value !== 'system') return value
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply() {
  resolved.value = resolve(preference.value)
  document.documentElement.dataset.theme = resolved.value
  document.documentElement.dataset.family = family.value
  document.documentElement.style.colorScheme = resolved.value
}

function watchSystem() {
  mediaQuery?.removeEventListener('change', apply)
  mediaQuery = preference.value === 'system' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  mediaQuery?.addEventListener('change', apply)
}

export function initializeTheme(forcedTheme?: ResolvedTheme, forcedFamily?: ThemeFamily) {
  if (forcedTheme) {
    resolved.value = forcedTheme
    if (forcedFamily) family.value = forcedFamily
    document.documentElement.dataset.theme = forcedTheme
    document.documentElement.dataset.family = family.value
    document.documentElement.style.colorScheme = forcedTheme
    mediaQuery?.removeEventListener('change', apply)
    mediaQuery = null
    return
  }
  apply()
  watchSystem()
}

export function useTheme() {
  function setTheme(value: ThemePreference) {
    preference.value = value
    localStorage.setItem('gugu-theme', value)
    apply()
    watchSystem()
  }

  function setFamily(value: ThemeFamily) {
    family.value = value
    localStorage.setItem('gugu-theme-family', value)
    apply()
  }

  return {
    preference: computed(() => preference.value),
    resolved: computed(() => resolved.value),
    family: computed(() => family.value),
    setTheme,
    setFamily,
  }
}
