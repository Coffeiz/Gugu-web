import { describe, expect, it, vi } from 'vitest'
import { sanitizeMediaPayload } from '../../../src/agent/context/messages/media.js'
import { renderOpenaiHistory } from '../../../src/agent/providers/openai/history.js'
import { resolveCurrentTurnImages, resolveCurrentTurnTextAttachments } from '../../../src/agent/attachments/current-turn.js'

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

it('当前轮图片内联至 Provider 请求，持久投影仅保留占位文案', async () => {
  const file = { ...attachment, attach_id: 'a'.repeat(32), kind: 'image' }
  const readImage = vi.fn(async () => ({ bytes: Uint8Array.of(1, 2, 3), mime: 'image/jpeg' }))
  const result = await resolveCurrentTurnImages([file], { maxInputBytes: 5, readImage })
  expect(result.notice).toBe('用户上传了 1 张图片。')
  expect(renderOpenaiHistory([{ role: 'user', content: result.blocks }])).toMatchObject([{
    role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } }],
  }])
  expect(sanitizeMediaPayload(result.blocks)).toEqual([{ type: 'text', text: '[图片已查看]' }])
})

it('无视觉端口、超出源文件预算或第七张图片时保留查看提示', async () => {
  const files = Array.from({ length: 8 }, (_, index) => ({
    ...attachment, kind: 'image', attach_id: index.toString(16).repeat(32), size: index === 0 ? 6 : 4, quoted: index === 2 || index === 7,
  }))
  const readImage = vi.fn(async () => ({ bytes: Uint8Array.of(1), mime: 'image/png' }))
  const inline = await resolveCurrentTurnImages(files, { maxInputBytes: 5, readImage })
  expect(readImage.mock.calls).toHaveLength(6)
  expect(inline.blocks).toHaveLength(6)
  expect(inline.notice).toContain(files[0]!.attach_id)
  expect(inline.notice).toContain('其中第 2 张来自引用消息')
  expect(inline.notice).toContain(`引用消息中的图片可用 view_image 查看（attach_id：${files[7]!.attach_id}）`)
  const deferred = await resolveCurrentTurnImages(files)
  expect(deferred.blocks).toEqual([])
  expect(deferred.notice).toContain('view_image')
})
