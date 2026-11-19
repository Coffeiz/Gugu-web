import { describe, expect, it } from 'vitest'
import { escapeTelegramMarkdownV2, splitMarkdownV2 as splitTelegramMarkdownV2, markdownV2 as telegramMarkdownV2 } from '../../src/im/telegram-format.js'

describe('Telegram MarkdownV2 回复格式与安全分片', () => {
  it('保留基础粗斜体、链接、代码并转义特殊文本', () => {
    const formatted = telegramMarkdownV2('**bold _inner_** and *italic!* [link](https://example.test/a?x=1&y=2)\n`a_b`')
    expect(formatted).toContain('*bold \\_inner\\_*')
    expect(formatted).toContain('_italic\\!_')
    expect(formatted).toContain('[link](https://example.test/a?x=1&y=2)')
    expect(formatted).toContain('`a_b`')
    expect(formatted).not.toContain('\\n')
    expect(telegramMarkdownV2('# 标题\n~~删除~~ _斜体_')).toBe('*标题*\n~删除~ _斜体_')
  })

  it('特殊字符逐个转义，空文本稳定返回单个空片', () => {
    expect(escapeTelegramMarkdownV2('_[]()~`>#+-=|{}.!\\')).toBe('\\_\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\')
    expect(splitTelegramMarkdownV2('')).toEqual([''])
  })

  it.each([
    ['javascript:alert(1)', 'unsafe (javascript:alert\\(1)\\)'],
    ['file:///private/path', 'unsafe (file:///private/path)'],
    ['//example.test/path', 'unsafe (//example\\.test/path)'],
    ['https://[bad', 'unsafe (https://\\[bad)'],
  ])('危险或无效链接 %s 不成为活动Markdown链接', (url, expected) => {
    const formatted = telegramMarkdownV2(`[unsafe](${url})`)
    expect(formatted).not.toContain('[unsafe](')
    // 按 Python 的可见降级文本逐字对照，不把链接恢复成可点击格式。
    expect(formatted).toBe(expected)
  })

  it('列表、编号和复选框保留可读展示', () => {
    expect(telegramMarkdownV2('- 普通项\n1) 有序项\n- [x] 完成\n- [ ] 未完成')).toBe('• 普通项\n1\\. 有序项\n☑ 完成\n☐ 未完成')
    expect(telegramMarkdownV2('  + 嵌套\n* [X] 完成\n12. 编号')).toBe('  • 嵌套\n☑ 完成\n12\\. 编号')
  })

  it('长纯文本按UTF16安全分片，不切断emoji和转义实体', () => {
    const source = '😀a_b '.repeat(1000) + '尾', chunks = splitTelegramMarkdownV2(source, 512)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 512)).toBe(true)
    expect(chunks.join('')).toBe(escapeTelegramMarkdownV2(source))
    for (const chunk of chunks) expect(chunk.isWellFormed()).toBe(true)
    const emoji = splitTelegramMarkdownV2('😀'.repeat(2100))
    expect(emoji).toHaveLength(2)
    expect(emoji.every(chunk => chunk.length <= 4096)).toBe(true)
    expect(emoji.join('')).toBe('😀'.repeat(2100))
  })

  it('长围栏在每片关闭和重开，代码特殊字符逐字保留', () => {
    const content = 'a_b😀\\`'.repeat(400) + '\n', chunks = splitTelegramMarkdownV2('```python\n' + content + '```', 512)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.startsWith('```python\n') && chunk.endsWith('```') && chunk.length <= 512)).toBe(true)
    expect(chunks.map(chunk => chunk.slice('```python\n'.length, -3)).join('')).toBe(content.replaceAll('\\', '\\\\').replaceAll('`', '\\`'))
  })

  it('四反引号围栏含内层短围栏，正文不会被格式化或提前关闭', () => {
    expect(telegramMarkdownV2('````md\n**原文**\n```\n_原文_\n````')).toBe('```md\n**原文**\n\\`\\`\\`\n_原文_\n```')
    expect(telegramMarkdownV2('~~~js\nconst a = 1;\n~~~')).toBe('```js\nconst a = 1;\n```')
  })

  it('未闭合围栏补闭合，非法语言标记删除且代码不丢失', () => {
    expect(telegramMarkdownV2('```python\n**原文**')).toBe('```python\n**原文**```')
    expect(telegramMarkdownV2('```bad!lang\ncode\n```')).toBe('```\ncode\n```')
    expect(telegramMarkdownV2('```c++ description\ncode\n```')).toBe('```c++\ncode\n```')
  })

  it('长链接降为安全文本，混合围栏的前后文本维持顺序', () => {
    const link = '[合成链接](https://example.test/' + 'a'.repeat(700) + ')'
    const chunks = splitTelegramMarkdownV2(link, 128)
    expect(chunks.every(chunk => chunk.length <= 128)).toBe(true)
    expect(chunks.join('')).toBe(escapeTelegramMarkdownV2(link))
    const mixed = splitTelegramMarkdownV2('前文\n```js\n' + 'x'.repeat(600) + '\n```\n尾文', 128)
    expect(mixed[0]).toBe('前文\n')
    expect(mixed.at(-1)).toBe('\n尾文')
    expect(mixed.every(chunk => chunk.length <= 128)).toBe(true)
  })

  it('拒绝非整数或无法容纳单个Unicode字符的长度限制', () => {
    for (const limit of [0, 1, -1, 2.5, NaN, Infinity]) expect(() => splitTelegramMarkdownV2('合成文本', limit)).toThrow('Telegram 消息长度限制无效')
  })
})
