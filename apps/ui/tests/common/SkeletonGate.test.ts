import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, provide, ref } from 'vue'
import SkeletonGate from '@/components/common/feedback/skeleton/SkeletonGate.vue'
import { skeletonDeadlineKey } from '@/composables/core/useDelayedSkeleton'

let app: ReturnType<typeof createApp> | undefined

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => {
  app?.unmount()
  app = undefined
  vi.useRealTimers()
})

function mount(deadline?: number) {
  const loading = ref(true)
  const host = document.createElement('div')
  app = createApp({
    setup() {
      provide(skeletonDeadlineKey, ref(deadline))
      return () => loading.value
        ? h(SkeletonGate, { preserveShell: true }, {
          default: ({ visible }: { visible: boolean }) => h('section', visible ? '骨架' : ''),
        })
        : h('section', '内容')
    },
  })
  app.mount(host)
  return { host, loading }
}

it('快加载保留面板并直接展示内容，取消未到期的骨架计时', async () => {
  const { host, loading } = mount()
  expect(host.querySelector('section')).not.toBeNull()
  await vi.advanceTimersByTimeAsync(149)
  expect(host.textContent).toBe('')
  loading.value = false
  await nextTick()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(100)
  expect(host.textContent).toBe('内容')
})

it('慢加载在 150 ms 展示骨架，加载结束立即替换', async () => {
  const { host, loading } = mount()
  await vi.advanceTimersByTimeAsync(149)
  expect(host.textContent).toBe('')
  await vi.advanceTimersByTimeAsync(1)
  expect(host.textContent).toBe('骨架')
  loading.value = false
  await nextTick()
  expect(host.textContent).toBe('内容')
})

it('路由已使用的时间计入首批数据的等待门槛', async () => {
  const deadline = performance.now() + 150
  await vi.advanceTimersByTimeAsync(100)
  const { host } = mount(deadline)
  await vi.advanceTimersByTimeAsync(49)
  expect(host.textContent).toBe('')
  await vi.advanceTimersByTimeAsync(1)
  expect(host.textContent).toBe('骨架')
})
