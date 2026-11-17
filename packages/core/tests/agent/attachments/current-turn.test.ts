import { describe, expect, it, vi } from 'vitest'
import { resolveCurrentTurnTextAttachments } from '../../../src/agent/attachments/current-turn.js'

const attachment = {
  attach_id: 'synthetic-attach', name: '设计稿', ext: 'txt', mime: 'text/plain',
  size: 4, kind: 'text', qq_face: false, quoted: false,
}

describe('current turn text attachment preparation', () => {
  it('injects owner-resolved text as a bounded attachment section while preserving the user query', async () => {
    const readText = vi.fn(async () => '第一行\n第二行')

    const result = await resolveCurrentTurnTextAttachments('请总结', [attachment], readText)

    expect(result.rawText).toContain('请总结')
    expect(result.rawText).toContain('《设计稿.txt》(attach_id=synthetic-attach)')
    expect(result.rawText).toContain('第一行\n第二行')
    expect(result.cards).toEqual([{
      attach_id: 'synthetic-attach', name: '设计稿', ext: 'txt', size_bytes: 4,
      kind: 'text', upload: true, mime: 'text/plain', qq_face: false,
      quoted: false, duration: null, img_width: null, img_height: null,
    }])
    expect(readText).toHaveBeenCalledTimes(1)
  })

  it('refuses oversized text before asking the host to read bytes', async () => {
    const readText = vi.fn(async () => 'must not be read')

    const result = await resolveCurrentTurnTextAttachments('请总结', [{ ...attachment, size: 33 * 1024 * 1024 }], readText)

    expect(readText).not.toHaveBeenCalled()
    expect(result.rawText).toContain('未直接读取')
    expect(result.rawText).not.toContain('must not be read')
    expect(result.rawText).not.toContain('```')
  })

  it('keeps a card and empty fenced content when extraction fails, without exposing the error', async () => {
    const readText = vi.fn(async () => { throw new Error('synthetic storage secret') })

    const result = await resolveCurrentTurnTextAttachments('', [attachment], readText)

    expect(result.rawText).toContain('内容如下：\n```\n\n```')
    expect(result.rawText).not.toContain('synthetic storage secret')
    expect(result.cards).toHaveLength(1)
  })
})
