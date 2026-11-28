import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { loadRemoteMailImages } from '../src/remote-images.js'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('node:https', () => ({ get: mocks.get }))

it('只下载邮件中标记的图片，重定向目标重新验证，结果以数据图片返回', async () => {
  const resolveAddress = vi.fn(async (host: string) => {
    if (host === 'private.example.test') throw new Error('非公开地址')
    return '192.0.2.1'
  })
  mocks.get.mockImplementation((url: URL, options: { lookup: Function }, callback: (value: Readable) => void) => {
    expect(options.lookup).toBeTypeOf('function')
    const response = Object.assign(Readable.from([Buffer.from('合成图像')]), url.pathname === '/redirect'
      ? { statusCode: 302, headers: { location: 'https://second.example.test/image' } }
      : { statusCode: 200, headers: { 'content-type': 'image/png' } })
    queueMicrotask(() => callback(response))
    return new EventEmitter()
  })
  const result = await loadRemoteMailImages(
    '<img data-mail-image="https://first.example.test/redirect"><td style="color:#333" data-mail-background="https://first.example.test/redirect">正文</td><img data-mail-image="https://private.example.test/image"><a href="https://link.example.test/">链接</a>',
    resolveAddress,
  )
  expect(resolveAddress.mock.calls.map(([host]) => host).sort()).toEqual(['first.example.test', 'private.example.test', 'second.example.test'])
  expect(mocks.get).toHaveBeenCalledTimes(2)
  expect(result.html).toContain('src="data:image/png;base64,')
  expect(result.html).toContain('style="color:#333;background-image:url(data:image/png;base64,')
  expect(result.html).not.toContain('src="https:')
  expect(result.unavailableImages).toBe(1)
})

it('宿主传输只补齐未加载图片并保留缓存内容', async () => {
  const resolveAddress = vi.fn(async () => '192.0.2.1')
  const cancel = vi.fn()
  const requestImage = vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: Readable.from([Buffer.from('新图片')]),
    cancel,
  }))
  const result = await loadRemoteMailImages(
    '<img src="data:image/png;base64,YQ=="><img data-mail-image="https://images.example.test/missing.png">',
    resolveAddress, requestImage,
  )
  expect(resolveAddress).not.toHaveBeenCalled()
  expect(requestImage).toHaveBeenCalledExactlyOnceWith(new URL('https://images.example.test/missing.png'), expect.any(AbortSignal))
  expect(result.html).toContain('src="data:image/png;base64,YQ=="')
  expect(result.html).not.toContain('data-mail-image=')
  expect(result.unavailableImages).toBe(0)
})

it('通用二进制响应须能识别为图片才能加载', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a35sAAAAASUVORK5CYII=', 'base64')
  const result = await loadRemoteMailImages(
    '<img data-mail-image="https://example.test/valid"><img data-mail-image="https://example.test/unknown">',
    async () => '192.0.2.1',
    async url => ({ status: 200, headers: { 'content-type': 'application/octet-stream' },
      body: Readable.from([url.pathname === '/valid' ? png : Buffer.from('无效数据')]), cancel() {} }),
  )
  expect(result.html).toContain('src="data:image/png;base64,')
  expect(result.unavailableImages).toBe(1)
})
