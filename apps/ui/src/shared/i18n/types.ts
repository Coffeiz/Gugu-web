export const supportedLocales = ['zh-CN', 'ja-JP', 'en-US'] as const

export type SupportedLocale = typeof supportedLocales[number]

/** 语言选择器使用各语言的原生名称，切换界面语言时按钮文案保持稳定。 */
export const localeOptions: ReadonlyArray<{ value: SupportedLocale; label: string }> = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'en-US', label: 'English' },
]

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && (supportedLocales as readonly string[]).includes(value)
}

export function mapBrowserLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== 'string') return null
  const language = value.trim().toLowerCase()
  if (language.startsWith('zh')) return 'zh-CN'
  if (language.startsWith('ja')) return 'ja-JP'
  if (language) return 'en-US'
  return null
}

export function detectBrowserLocale(languages?: readonly string[]): SupportedLocale {
  const candidates = languages ?? (
    typeof navigator !== 'undefined'
      ? (navigator.languages?.length ? navigator.languages : [navigator.language])
      : []
  )
  for (const candidate of candidates) {
    const mapped = mapBrowserLocale(candidate)
    if (mapped) return mapped
  }
  return 'zh-CN'
}
