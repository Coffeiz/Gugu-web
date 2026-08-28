import { computed, ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type ThemeFamily = 'glass' | 'v2'
export type ThemePalette = 'lavender' | 'ocean' | 'rose' | 'mono'

const preference = ref<ThemePreference>(readPreference())
const resolved = ref<ResolvedTheme>(resolve(preference.value))
const family = ref<ThemeFamily>(readFamily())
const palette = ref<ThemePalette>(readPalette())
let mediaQuery: MediaQueryList | null = null

function readPreference(): ThemePreference {
  const value = localStorage.getItem('gugu-theme')
  return value === 'dark' || value === 'system' ? value : 'light'
}

function readFamily(): ThemeFamily {
  return localStorage.getItem('gugu-theme-family') === 'v2' ? 'v2' : 'glass'
}

function readPalette(): ThemePalette {
  const value = localStorage.getItem('gugu-palette')
  return value === 'ocean' || value === 'rose' || value === 'mono' ? value : 'lavender'
}

function resolve(value: ThemePreference): ResolvedTheme {
  if (value !== 'system') return value
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply() {
  resolved.value = resolve(preference.value)
  document.documentElement.dataset.theme = resolved.value
  document.documentElement.dataset.family = family.value
  document.documentElement.dataset.palette = palette.value
  document.documentElement.style.colorScheme = resolved.value
}

function watchSystem() {
  mediaQuery?.removeEventListener('change', apply)
  mediaQuery = preference.value === 'system' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  mediaQuery?.addEventListener('change', apply)
}

export function initializeTheme(forcedTheme?: ResolvedTheme, forcedFamily?: ThemeFamily, forcedPalette?: ThemePalette) {
  if (forcedTheme) {
    resolved.value = forcedTheme
    if (forcedFamily) family.value = forcedFamily
    if (forcedPalette) palette.value = forcedPalette
    document.documentElement.dataset.theme = forcedTheme
    document.documentElement.dataset.family = family.value
    document.documentElement.dataset.palette = palette.value
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

  function setPalette(value: ThemePalette) {
    palette.value = value
    localStorage.setItem('gugu-palette', value)
    apply()
  }

  return {
    preference: computed(() => preference.value),
    resolved: computed(() => resolved.value),
    family: computed(() => family.value),
    palette: computed(() => palette.value),
    setTheme,
    setFamily,
    setPalette,
  }
}
