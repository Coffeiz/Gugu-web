// @vitest-environment node
import { effectScope, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { filesApi } from '@/services/api'
import { useProjectFileCounts } from '@/composables/projects/useProjectFileCounts'

vi.mock('@/services/api', () => ({
  filesApi: { tree: vi.fn() },
}))

describe('useProjectFileCounts', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('只加载聚合树计数，并在文件资源变更后合并刷新', async () => {
    vi.useFakeTimers()
    const revision = ref(0)
    const scope = effectScope()
    const state = scope.run(() => useProjectFileCounts(revision))!
    vi.mocked(filesApi.tree).mockResolvedValue({
      projects: [{ id: 7, name: '测试项目', color: '#778899', totalCount: 12 }],
      personalCount: 0,
      personalRootCount: 0,
    })

    expect(filesApi.tree).not.toHaveBeenCalled()
    await state.refresh()
    expect(state.counts.value?.get(7)).toBe(12)
    expect(filesApi.tree).toHaveBeenCalledTimes(1)

    revision.value += 1
    revision.value += 1
    await nextTick()
    await vi.advanceTimersByTimeAsync(120)

    expect(filesApi.tree).toHaveBeenCalledTimes(2)
    scope.stop()
  })
})
