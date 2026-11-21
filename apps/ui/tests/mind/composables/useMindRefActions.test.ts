// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { projectAccessKey } from '@/api/projects'
import { webProjectAccess } from '@web/projects/access'
import { filesApi } from '@/services/api'
import { createApp } from 'vue'
import { locateConversationMessageKey, openProjectReferenceKey, useMindRefActions } from '@/composables/mind/useMindRefActions'
import { showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'

vi.mock('@/services/mindAccess', () => ({ useMindAccess: () => ({}) }))
vi.mock('@/services/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/api')>(),
  filesApi: { get: vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { status: 404 })) },
  agentApi: {},
}))
vi.mock('@/api/calendar', () => ({ eventsApi: {} }))

vi.mock('@/composables/core/useAppToast', () => ({
  showAppNotice: vi.fn(), showAppError: vi.fn(), errorMessage: vi.fn(),
}))

describe('useMindRefActions', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    const pinia = createPinia()
    app = createApp({}).use(pinia).provide(projectAccessKey, webProjectAccess)
    setActivePinia(pinia)
    vi.clearAllMocks()
  })

  it('旧数字文件引用标记为失效，点击时不查询旧接口', async () => {
    const { openMindRef } = app.runWithContext(useMindRefActions)

    await expect(openMindRef('file', 1393)).resolves.toBe(false)
    expect(filesApi.get).not.toHaveBeenCalled()
    expect(showAppNotice).toHaveBeenCalledWith(i18n.global.t('mindUi.referenceMissing'))
  })

  it('平台消息定位使用同一跳转状态，旧请求不会覆盖最近点击', async () => {
    let finish!: (value: { id: number; sessionId: number }) => void
    const locate = vi.fn(async (id: number) => {
      if (id === 17) return new Promise<{ id: number; sessionId: number }>(resolve => { finish = resolve })
      if (id === 19) throw Object.assign(new Error('消息不存在'), { code: 'not_found' })
      return { id, sessionId: 7 }
    })
    app.provide(locateConversationMessageKey, locate)
    const { openMindRef, resolveMindRef } = app.runWithContext(useMindRefActions)
    const older = openMindRef('conversation', 17)
    await expect(openMindRef('conversation', 18)).resolves.toBe(true)
    finish({ id: 17, sessionId: 6 })
    await expect(older).resolves.toBe(false)
    expect(useUiStore().pendingChatNavigation).toMatchObject({ sessionId: 7, messageId: 18 })
    expect(locate.mock.calls).toEqual([[17], [18]])
    await expect(resolveMindRef('conversation', 19)).resolves.toBe('missing')
    await expect(openMindRef('conversation', 19)).resolves.toBe(false)
    expect(showAppNotice).toHaveBeenCalledWith(i18n.global.t('mindUi.referenceMissing'))
  })

  it('桌面项目引用直接打开指定项目，不等待项目列表', async () => {
    const openProject = vi.fn(async (id: number) => {
      if (id === 43) throw Object.assign(new Error('项目不存在'), { code: 'not_found' })
      return true
    })
    app.provide(openProjectReferenceKey, openProject)
    const { openMindRef } = app.runWithContext(useMindRefActions)
    await expect(openMindRef('project', 42)).resolves.toBe(true)
    await expect(openMindRef('project', 43)).resolves.toBe(false)
    expect(openProject.mock.calls).toEqual([[42], [43]])
    expect(showAppNotice).toHaveBeenCalledWith(i18n.global.t('mindUi.referenceMissing'))
  })
})
