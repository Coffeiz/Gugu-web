import { messages } from './messages'
import { isSupportedLocale, supportedLocales, type SupportedLocale } from './types'

/**
 * 所有界面文案的唯一注册入口。
 * 组件只通过 vue-i18n 读取，不直接依赖某个语言文件。
 */
export const localeRegistry: Record<SupportedLocale, Record<string, unknown>> = messages

export function hasLocale(locale: string | null | undefined): locale is SupportedLocale {
  return isSupportedLocale(locale) && supportedLocales.includes(locale)
}

export { supportedLocales }
