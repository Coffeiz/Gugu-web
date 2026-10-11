// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { localeRegistry } from '@/i18n/registry'

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

describe('locale message registry', () => {
  it('keeps every locale on the same key set', () => {
    const baseline = leafPaths(localeRegistry['zh-CN']).sort()
    expect(leafPaths(localeRegistry['ja-JP']).sort()).toEqual(baseline)
    expect(leafPaths(localeRegistry['en-US']).sort()).toEqual(baseline)
  })

  it('compiles Telegram group guidance messages containing literal @ characters in every locale', () => {
    const keys = [
      'profileImUi.telegramGroupResponseHint',
      'profileImUi.telegramGroupGuideTitle',
      'profileImUi.telegramGroupGuideStep1',
      'profileImUi.telegramGroupGuideStep2',
      'profileImUi.telegramGroupGuideStep3',
      'profileImUi.telegramGroupGuideNote',
    ]

    for (const locale of ['zh-CN', 'ja-JP', 'en-US'] as const) {
      const i18n = createI18n({ legacy: false, locale, messages: localeRegistry })
      const translated = keys.map(key => i18n.global.t(key))
      expect(translated.join(' ')).toContain('@')
    }
  })
})
