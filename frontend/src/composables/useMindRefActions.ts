/**
 * 笔记里 `[[type:id|label]]` 对象引用 chip 的点击行为——项目跳全局编辑 Modal、文件按类型
 * 预览或下载、活动弹全局编辑 Modal、对话打开咕咕面板并切到对应会话。NoteCard.vue（只读
 * 预览）和 NoteEditor.vue（编辑态）两处点击入口共用同一份逻辑，别各写一份判断分支。
 */
import { useProjectStore } from '@/stores/projects'
import { useEventModalStore } from '@/stores/eventModal'
import { useFilesCacheStore } from '@/stores/filesCache'
import { usePreviewStore, isPreviewable } from '@/stores/preview'
import { useUiStore } from '@/stores/ui'
import { filesApi } from '@/services/api'

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

  function openMindRef(refType: string, refId: number) {
    if (refType === 'project') projectStore.openModal({ id: refId })
    else if (refType === 'file') openFile(refId)
    else if (refType === 'event') eventModalStore.openModal(refId)
    // 顶栏全局搜索点「对话」结果走的同一套机制（见 GuguChat.vue 的 pendingChatSession watch）：
    // 打开咕咕悬浮面板、切到该会话，不用再写一套单独的打开逻辑。
    else if (refType === 'conversation') uiStore.pendingChatSession = refId
  }

  return { openMindRef }
}
