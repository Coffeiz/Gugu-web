import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useFilesCacheStore } from '@/stores/filesCache'
import { useMindRefActions } from './useMindRefActions'
import { showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'

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
    filesCache.loaded = true
    vi.spyOn(filesCache, 'refresh').mockImplementation(async () => {
      filesCache.allFiles = []
    })
    const { openMindRef } = useMindRefActions()

    await expect(openMindRef('file', 1393)).resolves.toBe(false)
    expect(showAppNotice).toHaveBeenCalledWith(i18n.global.t('mindUi.referenceMissing'))
  })
})
