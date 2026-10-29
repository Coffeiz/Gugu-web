import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  uploadGroupPersonality: vi.fn(),
}))

vi.mock('@/services/api', () => ({
  preferencesApi: {
    get: mocks.get,
    update: mocks.update,
    uploadGroupPersonality: mocks.uploadGroupPersonality,
  },
}))

vi.mock('@/i18n', () => ({
  isSupportedLocale: () => false,
  setLocale: vi.fn(),
}))

vi.mock('@/composables/core/useTheme', () => ({ applyServerTheme: vi.fn() }))
vi.mock('@/interaction/sync/InteractionSync', () => ({ InteractionSync: { execute: vi.fn() } }))

import { usePreferencesStore } from '@/stores/preferences'

describe('群聊人格偏好', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.get.mockReset()
    mocks.update.mockReset()
    mocks.uploadGroupPersonality.mockReset()
  })

  it('读取群人格并保存文本与启用状态，不覆盖个人人格', async () => {
    mocks.get.mockResolvedValue({
      personalityPreference: '个人设定',
      personalityPreferenceEnabled: true,
      groupPersonalityPreference: '群聊设定',
      groupPersonalityPreferenceEnabled: false,
    })
    mocks.update.mockResolvedValue({
      personalityPreference: '个人设定',
      personalityPreferenceEnabled: true,
      groupPersonalityPreference: '新的群聊设定',
      groupPersonalityPreferenceEnabled: true,
      personalityPreferenceAvailable: true,
      personalityPreferenceRevision: 3,
    })
    const preferences = usePreferencesStore()

    await preferences.fetch()
    await preferences.saveGroupPersonalityPreference(' 新的群聊设定 ', true)

    expect(preferences.personalityPreference).toBe('个人设定')
    expect(preferences.personalityPreferenceEnabled).toBe(true)
    expect(preferences.groupPersonalityPreference).toBe('新的群聊设定')
    expect(preferences.groupPersonalityPreferenceEnabled).toBe(true)
    expect(mocks.update).toHaveBeenCalledWith({
      groupPersonalityPreference: '新的群聊设定',
      groupPersonalityPreferenceEnabled: true,
    })
  })

  it('上传群人格后只更新群人格状态', async () => {
    mocks.uploadGroupPersonality.mockResolvedValue({
      personalityPreference: '个人设定',
      personalityPreferenceEnabled: true,
      groupPersonalityPreference: '文件里的群聊设定',
      groupPersonalityPreferenceEnabled: false,
      personalityPreferenceAvailable: true,
      personalityPreferenceRevision: 4,
    })
    const preferences = usePreferencesStore()

    await preferences.uploadGroupPersonalityFile(new File(['群聊设定'], 'group-persona.md'))

    expect(preferences.groupPersonalityPreference).toBe('文件里的群聊设定')
    expect(preferences.groupPersonalityPreferenceEnabled).toBe(false)
    expect(preferences.personalityPreference).toBe('')
  })
})
