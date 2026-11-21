// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import { localeRegistry } from '@/i18n/registry'

const LOCALES = ['zh-CN', 'ja-JP', 'en-US'] as const

/**
 * 群聊选择门协议失败的可见文案。
 *
 * 后端只下发 `message_key`，界面按当前语言取文案（useChatStream 里 message_key
 * 优先于后端 message）。这里守住两件事：key 在三种语言下都能取到真实文案，
 * 以及中文文案不会引导用户「再说一遍」——群聊自动回复是群消息触发的，用户
 * 并没有对咕咕说过话，让他重发是误导。
 */
describe('群聊选择门失败的可见文案', () => {
  it('后端下发的 message_key 在三种语言下都能取到文案', () => {
    const translated = LOCALES.map((locale) => {
      const i18n = createI18n({ legacy: false, locale, messages: localeRegistry })
      const text = i18n.global.t('chatUi.groupReplyFailed')
      expect(text).not.toBe('chatUi.groupReplyFailed')
      expect(text.trim().length).toBeGreaterThan(0)
      return text
    })
    // 三种语言必须是各自翻好的文案，不能有一门漏翻译回落成同一句。
    expect(new Set(translated).size).toBe(3)
  })

  it('中文文案不引导用户重发，也不暴露实现术语', () => {
    const text = (localeRegistry['zh-CN'] as unknown as {
      chatUi: { groupReplyFailed: string }
    }).chatUi.groupReplyFailed
    expect(text).not.toContain('再说一遍')
    expect(text).not.toContain('协议')
    expect(text).not.toContain('工具')
  })
})
