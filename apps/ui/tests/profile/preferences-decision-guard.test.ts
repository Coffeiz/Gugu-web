// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { localPreferencesAccessKey } from '@/services/localPreferencesAccess'
import { expect, it, vi } from 'vitest'
import { usePreferencesStore } from '@/stores/preferences'

const ports = vi.hoisted(() => ({ appearance: vi.fn(), updateAppearance: vi.fn(), updateWeb: vi.fn() }))

vi.mock('@/services/api', () => ({ preferencesApi: { update: ports.updateWeb } }))

function createLocalPreferencesStore() {
  const pinia = createPinia()
  createApp({}).provide(localPreferencesAccessKey, {
    appearance: ports.appearance,
    updateAppearance: ports.updateAppearance,
    clearAgentMemory: vi.fn(),
    clearAgentAttachments: vi.fn(),
    isMemoryBusy: () => false,
  }).use(pinia)
  return usePreferencesStore(pinia)
}


it('桌面决策守卫读取本机偏好，切换走本地桥接并在保存失败时回滚', async () => {
  const preferences = createLocalPreferencesStore()
  ports.appearance.mockResolvedValue({ decisionGuardEnabled: true })
  ports.updateAppearance.mockResolvedValueOnce({ decisionGuardEnabled: false })
    .mockRejectedValueOnce(new Error('合成保存失败'))

  await preferences.fetch()
  expect(preferences.decisionGuardEnabled).toBe(true)
  await preferences.saveDecisionGuardEnabled(false)
  expect(ports.updateAppearance).toHaveBeenCalledWith({ decisionGuardEnabled: false })
  expect(preferences.decisionGuardEnabled).toBe(false)
  await preferences.saveDecisionGuardEnabled(true)
  expect(ports.updateAppearance).toHaveBeenCalledWith({ decisionGuardEnabled: true })
  expect(preferences.decisionGuardEnabled).toBe(false)
  expect(ports.updateWeb).not.toHaveBeenCalled()
})

it('桌面工具注入偏好读取和保存使用本机设置', async () => {
  const preferences = createLocalPreferencesStore()
  ports.appearance.mockResolvedValue({ toolInjectionMode: 'full' })
  ports.updateAppearance.mockResolvedValue({ toolInjectionMode: 'description' })

  await preferences.fetch()
  expect(preferences.toolInjectionMode).toBe('full')
  await preferences.saveToolInjectionMode('description')
  expect(preferences.toolInjectionMode).toBe('description')
  expect(ports.updateAppearance).toHaveBeenLastCalledWith({ toolInjectionMode: 'description' })
  expect(ports.updateWeb).not.toHaveBeenCalled()
})

it('桌面回复风格支持编辑、上传和停用，使用本机偏好接口', async () => {
  const preferences = createLocalPreferencesStore()
  ports.appearance.mockResolvedValue({ customReplyStyle: '旧风格', customReplyStyleEnabled: true })
  ports.updateAppearance.mockImplementation(async patch => patch)

  await preferences.fetch()
  expect(preferences.customReplyStyle).toBe('旧风格')
  await preferences.saveCustomReplyStyle('  编辑后的风格  ')
  expect(preferences.customReplyStyle).toBe('编辑后的风格')
  expect(ports.updateAppearance).toHaveBeenLastCalledWith({ customReplyStyle: '编辑后的风格' })

  const text = new TextEncoder().encode('上传的风格')
  const file = new File([text], 'reply-style.md')
  Object.defineProperty(file, 'arrayBuffer', { value: async () => text.buffer })
  await preferences.uploadCustomReplyStyle(file)
  expect(preferences.customReplyStyle).toBe('上传的风格')
  expect(ports.updateAppearance).toHaveBeenLastCalledWith({ customReplyStyle: '上传的风格' })
  await expect(preferences.uploadCustomReplyStyle(new File([], 'style.pdf'))).rejects.toThrow('Markdown 或 TXT')

  ports.updateAppearance.mockResolvedValueOnce({ customReplyStyle: '上传的风格', customReplyStyleEnabled: false })
  await preferences.saveCustomReplyStyleEnabled(false)
  expect(preferences.customReplyStyle).toBe('上传的风格')
  expect(preferences.customReplyStyleEnabled).toBe(false)
  expect(ports.updateAppearance).toHaveBeenLastCalledWith({ customReplyStyleEnabled: false })
  expect(ports.updateWeb).not.toHaveBeenCalled()
})
