// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { makeLazyThumbDirective } from '@/components/common/gugu-chat/lazyThumbDirective'

vi.mock('@/composables/shared/useThumbCache', () => ({
  getThumb: vi.fn(), getCachedThumb: vi.fn(), getThumbUrl: vi.fn(), getCachedThumbUrl: vi.fn(),
}))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('本地附件进入视口才读取，移除图片时释放预览地址', async () => {
  let intersect: () => void = () => { throw new Error('图片未开始观察') }
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      intersect = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    observe() {}
    disconnect() {}
  })
  const createObjectURL = vi.fn(() => 'blob:synthetic')
  const revokeObjectURL = vi.fn()
  class TestURL extends URL {}
  Object.assign(TestURL, { createObjectURL, revokeObjectURL })
  vi.stubGlobal('URL', TestURL)
  const read = vi.fn(async () => new Blob(['synthetic'], { type: 'image/png' }))
  const image = document.createElement('img')
  const directive = makeLazyThumbDirective('card', read)
  directive.mounted(image, { value: 'attachment' })
  expect(read).not.toHaveBeenCalled()
  intersect()
  await Promise.resolve()
  expect(read).toHaveBeenCalledWith('attachment')
  expect(image.getAttribute('src')).toBe('blob:synthetic')
  directive.unmounted(image)
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic')
})
