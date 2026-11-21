import { useMindAccess } from '@/services/mindAccess'
/**
 * 笔记里 `[[type:id|label]]` 对象引用 chip 的点击行为——项目跳全局编辑 Modal、文件按类型
 * 预览或下载、活动弹全局编辑 Modal、对话打开咕咕面板并定位到具体那条消息。NoteCard.vue
 * （只读预览）和 NoteEditor.vue（编辑态）两处点击入口共用同一份逻辑，别各写一份判断分支。
 */
import { useProjectStore } from '@/stores/projects'
import { useEventModalStore } from '@/stores/eventModal'
import { useFilesCacheStore } from '@/stores/filesCache'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { useUiStore } from '@/stores/ui'
import { hasInjectionContext, inject, type InjectionKey } from 'vue'
import { useRouter } from 'vue-router'
import { agentApi } from '@/services/api'
import { usePathFileAccess } from '@/services/pathFileAccess'
import { useFileOpenAccess } from '@/services/fileOpenAccess'
import { shouldOpenFileInSystem } from '@gugu/desktop-contracts/file-preview'
import { eventsApi } from '@/api/calendar'
import { errorMessage, showAppError, showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'

import { decodeMindFileReference } from './fileReference'

type LocateConversationMessage = (messageId: number) => Promise<{ id: number; sessionId: number }>
export const locateConversationMessageKey: InjectionKey<LocateConversationMessage> = Symbol('locateConversationMessage')
export const openProjectReferenceKey: InjectionKey<(id: number) => Promise<boolean>> = Symbol('openProjectReference')

export type MindRefState = 'available' | 'missing' | 'unknown'

export function useMindRefActions() {
  const pathFilesApi = usePathFileAccess()
  const mindApi = useMindAccess()
  const projectStore = useProjectStore()
  const eventModalStore = useEventModalStore()
  const filesCache = useFilesCacheStore()
  const router = useRouter()
  const previewStore = usePreviewStore()
  const fileOpenAccess = useFileOpenAccess()
  const uiStore = useUiStore()
  const injectionAvailable = hasInjectionContext()
  const locate = (injectionAvailable ? inject(locateConversationMessageKey, null) : null) ?? agentApi.getMessageLocation
  const openProjectReference = injectionAvailable ? inject(openProjectReferenceKey, null) : null

  function isNotFound(error: unknown) {
    const value = error as { status?: number; code?: string } | null
    return value?.status === 404 || value?.code === 'not_found'
  }

  /** 本体删除后保留标题快照；网络异常不能误标成「已删除」。 */
  async function resolveMindRef(
    refType: string,
    refId: number | string,
  ): Promise<MindRefState> {
    // 历史类型的 id 都是数字；mcp 等字符串 id 的类型在上面 openMindRef 已短路处理
    const numericId = Number(refId)
    if (refType === 'project') {
      if (!projectStore.projects.length && !projectStore.loading) await projectStore.fetchProjects()
      if (projectStore.loading && !projectStore.projects.length) return 'unknown'
      if (projectStore.error) return 'unknown'
      return projectStore.projects.some(project => project.id === numericId) ? 'available' : 'missing'
    }
    if (refType === 'file') return typeof refId === 'string' && /^(path|drop)-/u.test(refId) ? 'unknown' : 'missing'
    if (refType === 'folder') {
      if (filesCache.getFolder(numericId)) return 'available'
      try {
        return await filesCache.ensureFolder(numericId) ? 'available' : 'missing'
      } catch {
        return 'unknown'
      }
    }
    if (refType === 'event') {
      try {
        await eventsApi.get(numericId)
        return 'available'
      } catch (error) {
        return isNotFound(error) ? 'missing' : 'unknown'
      }
    }
    if (refType === 'conversation') {
      try {
        await locate(numericId)
        return 'available'
      } catch (error) {
        return isNotFound(error) ? 'missing' : 'unknown'
      }
    }
    return 'unknown'
  }

  // 文件夹引用：文件库尚不支持定位到具体目录，先打开文件库页（后续可加深链）。
  async function openFolder(_id: number) {
    await router.push('/files')
  }

  // 对话引用存的 refId 是消息 id（锚定的是"准确的聊天位置"，不是整个会话），先反查它
  // 属于哪个会话，再走跟顶栏全局搜索命中消息完全一样的跳转机制（GuguChat.vue 的
  // pendingChatNavigation：打开面板、切会话、滚到并高亮这条消息）。
  async function openConversationMessage(messageId: number) {
    if (!Number.isSafeInteger(messageId) || messageId < 1) return false
    const requestId = uiStore.beginChatNavigation()
    try {
      const loc = await locate(messageId)
      return uiStore.publishChatNavigation(requestId, loc.sessionId, messageId)
    } catch (error) {
      if (uiStore.isCurrentChatNavigation(requestId) && isNotFound(error))
        showAppNotice(i18n.global.t('mindUi.referenceMissing'))
      return false
    }
  }

  async function openMindRef(refType: string, refId: number | string) {
    if (refType === 'project' && openProjectReference) {
      const id = Number(refId)
      if (!Number.isSafeInteger(id) || id < 1) return false
      try { return await openProjectReference(id) }
      catch (error) {
        if (isNotFound(error)) showAppNotice(i18n.global.t('mindUi.referenceMissing'))
        else showAppError(errorMessage(error))
        return false
      }
    }
    if (refType === 'file' && typeof refId === 'string' && refId.startsWith('drop-')) {
      if (!fileOpenAccess?.openDroppedReference) return false
      try { await fileOpenAccess.openDroppedReference(refId); return true }
      catch (error) { showAppError(errorMessage(error)); return false }
    }
    if (refType === 'file' && typeof refId === 'string' && refId.startsWith('path-')) {
      const file = decodeMindFileReference(refId)
      if (!file) return false
      const filename = file.relativePath.split('/').at(-1)!
      const dot = filename.lastIndexOf('.')
      const ext = dot > 0 ? filename.slice(dot + 1) : ''
      const useSystem = fileOpenAccess && shouldOpenFileInSystem(fileOpenAccess.getOpenPreference(), ext)
      if (useSystem && fileOpenAccess.canOpenInSystem(file)) await fileOpenAccess.openInSystem(file)
      else if (!useSystem && isPreviewable(ext)) previewStore.open({ displayName: dot > 0 ? filename.slice(0, dot) : filename, ext, workspaceFile: file })
      else await pathFilesApi.download(file).catch(error => showAppNotice(error instanceof Error ? error.message : i18n.global.t('mindUi.referenceMissing')))
      return true
    }
    if (refType === 'canvas_note') {
      try {
        const location = await mindApi.canvasNoteLocation(Number(refId))
        uiStore.pendingCanvasTarget = { canvasId: location.canvasId, nodeId: Number(refId) }
        await router.push('/canvases')
        return true
      } catch (error) {
        if (isNotFound(error)) showAppNotice(i18n.global.t('mindUi.referenceMissing'))
        return false
      }
    }
    // 技能/MCP/定时任务：chip 点击直接跳对应管理页（本体验不存在"详情弹窗"）；
    // 引用存在性不在前端逐一校验，页面自身会展示列表与失效状态。
    if (refType === 'skill') {
      await router.push({ path: '/skills', query: { skill: String(refId) } })
      return true
    }
    if (refType === 'mcp') {
      await router.push({ path: '/mcp', query: { server: String(refId) } })
      return true
    }
    if (refType === 'scheduled_task') {
      await router.push({ path: '/schedules', query: { task: String(refId) } })
      return true
    }
    if (refType === 'folder') {
      const state = await resolveMindRef(refType, refId)
      if (state === 'missing') {
        showAppNotice(i18n.global.t('mindUi.referenceMissing'))
        return false
      }
      await openFolder(Number(refId))
      return true
    }
    if (refType === 'conversation') return openConversationMessage(Number(refId))
    const state = await resolveMindRef(refType, refId)
    if (state === 'missing') {
      showAppNotice(i18n.global.t('mindUi.referenceMissing'))
      return false
    }
    if (state !== 'available') return false
    // 走到这里的历史类型 id 一定是数字（新类型在上面已短路）
    const numericId = Number(refId)
    if (refType === 'project') projectStore.openModal({ id: numericId })
    else if (refType === 'event') eventModalStore.openModal(numericId)
    return true
  }

  return { openMindRef, resolveMindRef }
}
