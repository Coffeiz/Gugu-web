import { describe, expect, it } from 'vitest'
import { downloadSendFileImage } from '../../../src/agent/tools/files/send-file-image.js'

const imageUrl = 'https://files.example.invalid/photo'
const mebibyte = 1024 * 1024

describe('send_file 网络图片', () => {
  it.each([null, String(16 * mebibyte)])('超限时中止响应流（声明长度 %s）', async length => {
    let read = 0
    let cancelled = false
    const result = await downloadSendFileImage(imageUrl, async () => ({
      status: 200,
      headers: { 'content-type': 'image/png', ...(length === null ? {} : { 'content-length': length }) },
      body: (async function* () {
        const chunk = new Uint8Array(mebibyte)
        for (let index = 0; index < 32; index++) {
          read += chunk.byteLength
          yield chunk
        }
      })(),
      cancel() { cancelled = true },
    }), new AbortController().signal)
    expect(result).toEqual({ error: expect.stringContaining('图片过大') })
    expect(read).toBe(length === null ? 16 * mebibyte : 0)
    expect(cancelled).toBe(true)
  })

  it('最多跟随三跳并释放每次响应', async () => {
    const opened: string[] = []
    const cancelled: string[] = []
    const result = await downloadSendFileImage(imageUrl, async url => {
      opened.push(url)
      return {
        status: 302, headers: { location: `/hop-${opened.length}` },
        body: (async function* () { throw new Error('重定向不应读取响应正文') })(),
        cancel() { cancelled.push(url) },
      }
    }, new AbortController().signal)
    expect(result).toEqual({ error: '图片下载失败（HTTP 302）' })
    expect(opened).toEqual([imageUrl, ...[1, 2, 3].map(hop => new URL(`/hop-${hop}`, imageUrl).href)])
    expect(cancelled).toEqual(opened)
  })

  it.each([
    ['image/svg+xml', '这个链接返回的不是支持的图片格式'],
    ['image/webp; charset=utf-8', '下载到的内容是空的'],
  ])('拒绝不可用的图片响应（%s）', async (mime, error) => {
    const result = await downloadSendFileImage(imageUrl, async () => ({
      status: 200, headers: { 'content-type': mime }, body: (async function* () {})(), cancel() {},
    }), new AbortController().signal)
    expect(result).toEqual({ error })
  })
})
