// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useMindRefActions } from '@/composables/mind/useMindRefActions'
import { showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'

vi.mock('@/services/api', () => ({
  filesApi: { get: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { status: 404 })) },
  agentApi: {}, eventsApi: {}, mindApi: {},
}))

vi.mock('@/composables/core/useAppToast', () => ({
  showAppNotice: vi.fn(),
}))

describe('useMindRefActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('提示已删除的文件引用，而不是静默忽略点击', async () => {
    const filesCache = useFilesCacheStore()
    const { openMindRef } = useMindRefActions()

    await expect(openMindRef('file', 1393)).resolves.toBe(false)
    expect(showAppNotice).toHaveBeenCalledWith(i18n.global.t('mindUi.referenceMissing'))
  })
})
