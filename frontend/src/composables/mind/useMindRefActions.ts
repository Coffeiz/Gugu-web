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
import { useRouter } from 'vue-router'
import { filesApi, agentApi, eventsApi, mindApi } from '@/services/api'
import { showAppNotice } from '@/composables/core/useAppToast'
import { i18n } from '@/i18n'

export type MindRefState = 'available' | 'missing' | 'unknown'

// 同一批笔记可能同时解析多个文件引用；短时合并版本刷新，避免每个引用都单独请求文件列表。
let fileRefreshPromise: Promise<void> | null = null
let fileRefreshAt = 0
const FILE_REFRESH_COOLDOWN_MS = 5000

export function useMindRefActions() {
  const projectStore = useProjectStore()
  const eventModalStore = useEventModalStore()
  const filesCache = useFilesCacheStore()
  const router = useRouter()
  const previewStore = usePreviewStore()
  const uiStore = useUiStore()

  function isNotFound(error: unknown) {
    return (error as { status?: number }).status === 404
  }

  async function refreshFilesIfNeeded() {
    const now = Date.now()
    if (now - fileRefreshAt < FILE_REFRESH_COOLDOWN_MS) return
    if (!fileRefreshPromise) {
      fileRefreshPromise = filesCache.refresh().finally(() => {
        fileRefreshAt = Date.now()
        fileRefreshPromise = null
      })
    }
    await fileRefreshPromise
  }

  /** 本体删除后保留标题快照；网络异常不能误标成「已删除」。 */
  async function resolveMindRef(refType: string, refId: number | string): Promise<MindRefState> {
    // 历史类型的 id 都是数字；mcp 等字符串 id 的类型在上面 openMindRef 已短路处理
    const numericId = Number(refId)
    if (refType === 'project') {
      if (!projectStore.projects.length && !projectStore.loading) await projectStore.fetchProjects()
      if (projectStore.loading && !projectStore.projects.length) return 'unknown'
      if (projectStore.error) return 'unknown'
      return projectStore.projects.some(project => project.id === numericId) ? 'available' : 'missing'
    }
    if (refType === 'file') {
      if (!filesCache.loaded) await filesCache.load()
      if (!filesCache.loaded) return 'unknown'
      await refreshFilesIfNeeded()
      return filesCache.getFile(numericId) ? 'available' : 'missing'

    }
    if (refType === 'folder') {
      if (!filesCache.loaded) await filesCache.load()
      if (!filesCache.loaded) return 'unknown'
      return filesCache.getFolder(numericId) ? 'available' : 'missing'
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
        await agentApi.getMessageLocation(numericId)
        return 'available'
      } catch (error) {
        return isNotFound(error) ? 'missing' : 'unknown'
      }
    }
    return 'unknown'
  }

  async function openFile(id: number) {
    if (!filesCache.loaded) await filesCache.load()
    const file = filesCache.getFile(id)
    if (!file) {
      showAppNotice(i18n.global.t('mindUi.referenceMissing'))
      return
    }
    if (isPreviewable(file.ext, file.mimeType)) previewStore.open(file)
    else filesApi.download(file.id, `${file.displayName}.${file.ext}`).catch(() => {})
  }

  // 文件夹引用：文件库尚不支持定位到具体目录，先打开文件库页（后续可加深链）。
  async function openFolder(_id: number) {
    await router.push('/files')
  }

  // 对话引用存的 refId 是消息 id（锚定的是"准确的聊天位置"，不是整个会话），先反查它
  // 属于哪个会话，再走跟顶栏全局搜索命中消息完全一样的跳转机制（GuguChat.vue 的
  // pendingChatSession/pendingChatMessageId watch：打开面板、切会话、滚到并高亮这条消息）。
  async function openConversationMessage(messageId: number) {
    try {
      const loc = await agentApi.getMessageLocation(messageId)
      uiStore.pendingChatMessageId = messageId
      uiStore.pendingChatSession = loc.sessionId
    } catch { /* 消息已被删除/不可见：静默忽略，不弹错误打扰阅读 */ }
  }

  async function openMindRef(refType: string, refId: number | string) {
    if (refType === 'canvas_note') {
      try {
        const location = await mindApi.canvasNoteLocation(Number(refId))
        uiStore.pendingCanvasTarget = { canvasId: location.canvasId, nodeId: Number(refId) }
        await router.push('/mind/canvases')
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
    const state = await resolveMindRef(refType, refId)
    if (state === 'missing') {
      showAppNotice(i18n.global.t('mindUi.referenceMissing'))
      return false
    }
    if (state !== 'available') return false
    // 走到这里的历史类型 id 一定是数字（新类型在上面已短路）
    const numericId = Number(refId)
    if (refType === 'project') projectStore.openModal({ id: numericId })
    else if (refType === 'file') await openFile(numericId)
    else if (refType === 'folder') await openFolder(numericId)
    else if (refType === 'event') eventModalStore.openModal(numericId)
    else if (refType === 'conversation') await openConversationMessage(numericId)
    return true
  }

  return { openMindRef, resolveMindRef }
}
