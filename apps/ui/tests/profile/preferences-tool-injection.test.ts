// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/services/api', () => ({
  preferencesApi: { get: mocks.get },
}))

vi.mock('@/i18n', () => ({
  isSupportedLocale: () => false,
  setLocale: vi.fn(),
}))

vi.mock('@/composables/core/useTheme', () => ({
  applyServerTheme: vi.fn(),
}))

vi.mock('@/interaction/sync/InteractionSync', () => ({
  InteractionSync: { execute: vi.fn() },
}))

import { usePreferencesStore } from '@/stores/preferences'

describe('工具注入偏好默认值', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.get.mockReset()
  })

  it('未加载用户偏好前使用简介模式', () => {
    const preferences = usePreferencesStore()

    expect(preferences.toolInjectionMode).toBe('description')
  })

  it('加载到用户明确保存的全量模式后仍保留全量模式', async () => {
    mocks.get.mockResolvedValue({ toolInjectionMode: 'full' })
    const preferences = usePreferencesStore()

    await preferences.fetch()

    expect(preferences.toolInjectionMode).toBe('full')
  })
})
