import { computed, ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const preference = ref<ThemePreference>(readPreference())
const resolved = ref<ResolvedTheme>(resolve(preference.value))
let mediaQuery: MediaQueryList | null = null

function readPreference(): ThemePreference {
  const value = localStorage.getItem('gugu-theme')
  return value === 'dark' || value === 'system' ? value : 'light'
}

function resolve(value: ThemePreference): ResolvedTheme {
  if (value !== 'system') return value
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply() {
  resolved.value = resolve(preference.value)
  document.documentElement.dataset.theme = resolved.value
  document.documentElement.style.colorScheme = resolved.value
}

function watchSystem() {
  mediaQuery?.removeEventListener('change', apply)
  mediaQuery = preference.value === 'system' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  mediaQuery?.addEventListener('change', apply)
}

export function initializeTheme() {
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

  return {
    preference: computed(() => preference.value),
    resolved: computed(() => resolved.value),
    setTheme,
  }
}
