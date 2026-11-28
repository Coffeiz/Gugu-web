// @vitest-environment node
import { effectScope, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useProjectCollectionModals } from '@/composables/projects/useProjectCollectionModals'

describe('useProjectCollectionModals', () => {
  it('初次进入看板不请求归档或回收站，打开对应弹窗时才加载', async () => {
    const loadArchived = vi.fn(async () => undefined)
    const loadDeleted = vi.fn(async () => undefined)
    const scope = effectScope()
    const state = scope.run(() => useProjectCollectionModals({ loadArchived, loadDeleted }))!

    expect(loadArchived).not.toHaveBeenCalled()
    expect(loadDeleted).not.toHaveBeenCalled()

    state.showArchived.value = true
    await nextTick()
    expect(loadArchived).toHaveBeenCalledTimes(1)
    expect(loadDeleted).not.toHaveBeenCalled()

    state.showDeleted.value = true
    await nextTick()
    expect(loadDeleted).toHaveBeenCalledTimes(1)
    scope.stop()
  })
})
