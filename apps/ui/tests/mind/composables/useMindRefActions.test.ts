// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { fileOpenAccessKey } from '@/services/fileOpenAccess'
import { pathFileAccessKey } from '@/services/pathFileAccess'
import { openPlatformPreviewKey } from '@/stores/preview'
import { projectAccessKey } from '@/api/projects'
import { webProjectAccess } from '@web/projects/access'
import { filesApi, pathFilesApi } from '@/services/api'
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

  it.each([[true, '交给系统'], [false, '提供下载']] as const)('系统打开能力为 %s 时，桌面 .clip 引用%s', async (canOpenInSystem) => {
    const openInSystem = vi.fn(async () => {})
    const openPreview = vi.fn(() => true)
    const download = vi.fn(async () => {})
    app.provide(fileOpenAccessKey, {
      canOpenInSystem: () => canOpenInSystem, openInSystem, getOpenPreference: () => 'preview',
    }).provide(openPlatformPreviewKey, openPreview)
      .provide(pathFileAccessKey, { ...pathFilesApi, download })
    const { openMindRef } = app.runWithContext(useMindRefActions)
    const clip = { directoryId: 'personal', relativePath: 'drawing.clip', identity: '1.2.3' }
    const jpg = { ...clip, relativePath: 'image.jpg' }
    const encode = (file: typeof clip) => `path-${Buffer.from(JSON.stringify(file)).toString('base64url')}`

    await expect(openMindRef('file', encode(clip))).resolves.toBe(true)
    expect(openInSystem.mock.calls).toEqual(canOpenInSystem ? [[clip]] : [])
    expect(download.mock.calls).toEqual(canOpenInSystem ? [] : [[clip]])
    expect(openPreview).not.toHaveBeenCalled()
    await expect(openMindRef('file', encode(jpg))).resolves.toBe(true)
    expect(openPreview).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ext: 'jpg', workspaceFile: jpg }))
    expect(openInSystem).toHaveBeenCalledTimes(Number(canOpenInSystem))
    expect(download).toHaveBeenCalledTimes(Number(!canOpenInSystem))
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
