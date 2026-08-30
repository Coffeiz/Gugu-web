import { computed, ref } from 'vue'

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'
export type ThemeFamily = 'glass' | 'mono'
export type ThemePalette = 'mist' | 'cafe' | 'rose' | 'sky' | 'sage'

// 偏好必须在版本门执行后再读取，避免模块导入顺序让旧 localStorage 状态进入内存。
const preference = ref<ThemePreference>('light')
const resolved = ref<ResolvedTheme>('light')
const family = ref<ThemeFamily>('glass')
const palette = ref<ThemePalette>('mist')
let hydrated = false
let mediaQuery: MediaQueryList | null = null

function readPreference(): ThemePreference {
  const value = localStorage.getItem('gugu-theme')
  return value === 'dark' || value === 'system' ? value : 'light'
}

function readFamily(): ThemeFamily {
  const value = localStorage.getItem('gugu-theme-family')
  if (value === 'v2') {
    // 只做一次性迁移，运行时和后续写入都不再保留旧 family 名称。
    localStorage.setItem('gugu-theme-family', 'mono')
    return 'mono'
  }
  return value === 'mono' ? 'mono' : 'glass'
}

function readPalette(): ThemePalette {
  const value = localStorage.getItem('gugu-palette')
  const migrated: Record<string, ThemePalette> = {
    lavender: 'mist', amber: 'cafe', aero: 'mist', mono: 'cafe', coral: 'rose', blue: 'sky', teal: 'sage',
  }
  const next = migrated[value ?? '']
  if (next && next !== value) localStorage.setItem('gugu-palette', next)
  return next ?? 'mist'
}

function normalizePalette(value: unknown): ThemePalette {
  return value === 'mist' || value === 'cafe' || value === 'rose' || value === 'sky' || value === 'sage'
    ? value
    : 'mist'
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

function hydrate() {
  if (hydrated) return
  preference.value = readPreference()
  resolved.value = resolve(preference.value)
  family.value = readFamily()
  palette.value = readPalette()
  hydrated = true
}

export function initializeTheme(forcedTheme?: ResolvedTheme, forcedFamily?: ThemeFamily, forcedPalette?: ThemePalette) {
  hydrate()
  if (forcedTheme) {
    resolved.value = forcedTheme
    if (forcedFamily) family.value = forcedFamily
    if (forcedPalette) palette.value = normalizePalette(forcedPalette)
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
    const next = normalizePalette(value)
    palette.value = next
    localStorage.setItem('gugu-palette', next)
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
