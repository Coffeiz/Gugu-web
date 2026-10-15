// @vitest-environment node
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

const { fileCounts } = vi.hoisted(() => ({ fileCounts: vi.fn() }))

vi.mock('@/services/api', () => ({ projectsApi: { fileCounts } }))
vi.mock('@/composables/core/useAppToast', () => ({ showAppError: vi.fn() }))

import { useProjectFileCounts } from '@/composables/projects/useProjectFileCounts'

describe('useProjectFileCounts', () => {
  it('摘要返回前不伪造文件数量，刷新后使用服务端计数', async () => {
    fileCounts.mockResolvedValue([{ projectId: 3, fileCount: 4 }])
    const state = useProjectFileCounts(ref(0))
    expect(state.counts.value).toBeNull()

    await state.refresh()

    expect(state.counts.value).toEqual(new Map([[3, 4]]))
  })
})
