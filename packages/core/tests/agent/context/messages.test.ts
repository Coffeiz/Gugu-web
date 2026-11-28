import { describe, expect, it } from 'vitest'
import { sanitizeMediaPayload, extractPlatformMentionIds, replacePlatformMentionIds } from '../../../src/agent/context/messages/index.js'

describe('Agent 消息共享安全投影', () => {
  it('递归移除媒体内容并保留普通文字和安全外部图片引用', () => {
    const input = { events: [{ type: 'image', source: { data: 'synthetic-secret' } }, { type: 'video', data: 'synthetic-secret' }, { type: 'audio', data: 'synthetic-secret' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,synthetic-secret' } }, { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }, { type: 'text', text: '正文' }] }
    const value = sanitizeMediaPayload(input)
    expect(JSON.stringify(value)).not.toContain('synthetic-secret')
    expect(value).toEqual({ events: [{ type: 'text', text: '[图片已查看]' }, { type: 'text', text: '[视频已查看]' }, { type: 'text', text: '[音频已查看]' }, { type: 'text', text: '[图片已查看]' }, { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }, { type: 'text', text: '正文' }] })
  })
  it('仅提取合法 mention 并只替换已解析名称', () => {
    expect(extractPlatformMentionIds('<@person> <@!person> <@unknown>')).toEqual(['person', 'unknown'])
    expect(replacePlatformMentionIds('<@person> @person <@unknown>', new Map([['person', '小北']]))).toBe('@小北 @小北 <@unknown>')
  })
})
