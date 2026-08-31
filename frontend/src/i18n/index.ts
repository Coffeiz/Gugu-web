import { createI18n } from 'vue-i18n'
import { detectBrowserLocale, isSupportedLocale, localeOptions, type SupportedLocale } from './types'
import { localeRegistry } from './registry'

const LOCALE_KEY = 'gugu-locale'
const storedLocale = typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_KEY) : null
const initialLocale: SupportedLocale = isSupportedLocale(storedLocale) ? storedLocale : detectBrowserLocale()

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: 'zh-CN',
  messages: localeRegistry,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: import.meta.env.DEV,
})

export function setLocale(locale: SupportedLocale, persist = false) {
  i18n.global.locale.value = locale
  if (persist && typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_KEY, locale)
}

export function getLocale(): SupportedLocale {
  const value = i18n.global.locale.value
  return isSupportedLocale(value) ? value : 'zh-CN'
}

export { detectBrowserLocale, isSupportedLocale, localeOptions, type SupportedLocale } from './types'
