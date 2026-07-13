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
import { filesApi, agentApi } from '@/services/api'

export function useMindRefActions() {
  const projectStore = useProjectStore()
  const eventModalStore = useEventModalStore()
  const filesCache = useFilesCacheStore()
  const previewStore = usePreviewStore()
  const uiStore = useUiStore()

  async function openFile(id: number) {
    if (!filesCache.loaded) await filesCache.load()
    const file = filesCache.getFile(id)
    if (!file) return   // 文件已被删除/不可见：静默忽略，不弹错误打扰阅读
    if (isPreviewable(file.ext)) previewStore.open(file)
    else filesApi.download(file.id, `${file.displayName}.${file.ext}`).catch(() => {})
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

  function openMindRef(refType: string, refId: number) {
    if (refType === 'project') projectStore.openModal({ id: refId })
    else if (refType === 'file') openFile(refId)
    else if (refType === 'event') eventModalStore.openModal(refId)
    else if (refType === 'conversation') openConversationMessage(refId)
  }

  return { openMindRef }
}
