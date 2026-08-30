import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { detectBrowserLocale, mapBrowserLocale, localeOptions } from './types'
import { getLocale, setLocale } from './index'
import { messages } from './messages'

describe('i18n locale policy', () => {
  function messagePaths(value: unknown, prefix = ''): string[] {
    if (typeof value === 'string') return [prefix]
    if (!value || typeof value !== 'object') return []
    return Object.entries(value).flatMap(([key, child]) =>
      messagePaths(child, prefix ? `${prefix}.${key}` : key),
    )
  }

  it('语言选择器使用稳定的原生名称', () => {
    expect(localeOptions).toEqual([
      { value: 'zh-CN', label: '简体中文' },
      { value: 'ja-JP', label: '日本語' },
      { value: 'en-US', label: 'English' },
    ])
  })
  it('设置页的跟随系统选项不带状态提示括号', () => {
    expect(messages['zh-CN'].layout.followSystemOption).toBe('跟随系统')
    expect(messages['ja-JP'].layout.followSystemOption).toBe('システムに従う')
    expect(messages['en-US'].layout.followSystemOption).toBe('Follow system')
  })

  it('所有语言包文案都能被 vue-i18n 正常解析', () => {
    const paths = messagePaths(messages['en-US'])
    for (const locale of ['zh-CN', 'ja-JP', 'en-US'] as const) {
      const localI18n = createI18n({ legacy: false, locale, messages })
      for (const path of paths) {
        expect(() => localI18n.global.t(path)).not.toThrow()
      }
    }
  })
  it('maps supported browser language families', () => {
    expect(mapBrowserLocale('zh-TW')).toBe('zh-CN')
    expect(mapBrowserLocale('ja-JP')).toBe('ja-JP')
    expect(mapBrowserLocale('fr-FR')).toBe('en-US')
  })

  it('uses the first supported language and falls back to Chinese', () => {
    expect(detectBrowserLocale(['xx', 'ja'])).toBe('en-US')
    expect(detectBrowserLocale([])).toBe('zh-CN')
  })

  it('switches the runtime immediately and persists only when requested', () => {
    localStorage.clear()
    setLocale('ja-JP')
    expect(getLocale()).toBe('ja-JP')
    expect(localStorage.getItem('gugu-locale')).toBeNull()
    setLocale('en-US', true)
    expect(getLocale()).toBe('en-US')
    expect(localStorage.getItem('gugu-locale')).toBe('en-US')
  })
})
