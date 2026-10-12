// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import VideoViewer from '@/components/common/viewers/VideoViewer.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/common/icons/Icon.vue', () => ({ default: { render: () => null } }))

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function flushPromises() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
  await nextTick()
}

it('播放闲置超过签名地址有效期的视频前刷新地址并继续播放', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const refreshSrc = vi.fn().mockResolvedValue('/api/v1/files/5/stream?token=fresh')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(VideoViewer, { src: '/api/v1/files/5/stream?token=old', refreshSrc })
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)

  vi.setSystemTime(Date.now() + 9 * 60 * 1000)
  host.querySelector('.vv-wrap')?.dispatchEvent(new MouseEvent('mousemove'))
  await nextTick()
  host.querySelector<HTMLButtonElement>('.vv-center-btn')?.click()
  await flushPromises()

  expect(refreshSrc).toHaveBeenCalledOnce()
  expect(host.querySelector('video')?.getAttribute('src')).toBe('/api/v1/files/5/stream?token=fresh')
  expect(play).toHaveBeenCalledOnce()
  expect(host.querySelector('.vv-error')).toBeNull()
})

it('过期视频源加载失败时自动续签，避免继续显示不可播放错误', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const refreshSrc = vi.fn().mockResolvedValue('/api/v1/files/5/stream?token=fresh')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(VideoViewer, { src: '/api/v1/files/5/stream?token=old', refreshSrc })
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)

  vi.setSystemTime(Date.now() + 9 * 60 * 1000)
  host.querySelector('video')?.dispatchEvent(new Event('error'))
  await flushPromises()

  expect(refreshSrc).toHaveBeenCalledOnce()
  expect(host.querySelector('video')?.getAttribute('src')).toBe('/api/v1/files/5/stream?token=fresh')
  expect(host.querySelector('.vv-error')).toBeNull()
})

it('用户快速暂停打断尚未完成的 play 请求时不产生未处理错误提示', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new DOMException('Interrupted', 'AbortError'))
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(VideoViewer, { src: '/video.mp4' })
  cleanup = () => { app.unmount(); host.remove() }
  app.mount(host)

  host.querySelector('.vv-wrap')?.dispatchEvent(new MouseEvent('mousemove'))
  await nextTick()
  host.querySelector<HTMLButtonElement>('.vv-center-btn')?.click()
  await flushPromises()

  expect(host.querySelector('.vv-error')).toBeNull()
})
