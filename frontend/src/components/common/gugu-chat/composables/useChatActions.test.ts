import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchProjects = vi.fn()
const fetchUpcomingCalEvents = vi.fn()
const bump = vi.fn()

vi.mock('@/stores/projects', () => ({
  useProjectStore: () => ({ fetchProjects, fetchUpcomingCalEvents }),
}))
vi.mock('@/stores/live', () => ({
  useLiveStore: () => ({ bump }),
}))
vi.mock('@/stores/ui', () => ({
  useUiStore: () => ({ pendingFileTarget: null }),
}))
vi.mock('@/stores/preview', () => ({
  usePreviewStore: () => ({ open: vi.fn() }),
  isPreviewable: () => false,
}))
vi.mock('@/stores/filesCache', () => ({
  useFilesCacheStore: () => ({ loaded: true, allFiles: [], load: vi.fn() }),
}))

import { useChatActions } from './useChatActions'

describe('useChatActions 工具完成后的资源刷新', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('咕咕编辑定时任务后 bump scheduled_tasks，当前面板无需手动刷新', async () => {
    const { refreshAfterTools } = useChatActions({
      router: { push: vi.fn() } as never,
      onBindPlatform: vi.fn(),
      onOpenObject: vi.fn(),
      onOpenSkill: vi.fn(),
    })

    await refreshAfterTools(new Set(['update_scheduled_task']))

    expect(bump).toHaveBeenCalledWith('scheduled_tasks')
    expect(fetchProjects).not.toHaveBeenCalled()
    expect(fetchUpcomingCalEvents).not.toHaveBeenCalled()
  })
})
