import { useI18n } from 'vue-i18n'
import { runtime } from '@/interaction/runtime'
import { useMindStore } from '@/stores/mind'
import { useProjectStore } from '@/stores/projects'
import { showAppNotice } from '@/composables/core/useAppToast'
import { usePathFileAccess } from '@/services/pathFileAccess'
import type { ChatReference } from './chatTypes'
import { splitMindTitleBody } from '@/composables/mind/useMindEditor'

/** 磁盘文件 Runtime ID 由目录标识和原始相对路径组成。 */
export function parseChatRuntimePathFile(objectId: string, kind: 'file' | 'folder' = 'file') {
  const match = /(?:^|:)(file|folder):(personal|project:[1-9]\d*|desktop:[a-f0-9-]{36}|[1-9]\d*):([\s\S]+)$/.exec(objectId)
  if (!match || match[1] !== kind) return null
  const [, , key, relativePath] = match
  const directoryId = /^\d+$/.test(key) ? Number(key) : key as 'personal' | `project:${number}` | `desktop:${string}`
  return { directoryId, relativePath }
}

/** 将 Runtime 对象 ID 转成聊天编辑器可持有的业务引用。 */
export function parseChatRuntimeReference(objectId: string): ChatReference | null {
  const match = /(?:^|:)(project|file|folder):(\d+)$/.exec(objectId)
  if (!match) return null
  return { type: match[1] as ChatReference['type'], id: Number(match[2]), label: '' }
}

/** 将画布卡片节点还原成聊天引用；ref 卡使用其真实业务类型，便签使用独立 canvas_note 类型。 */
export function parseMindCanvasChatReference(node: {
  id: number
  kind: string
  refType?: string | null
  refId?: number | null
  title?: string | null
  contentMd?: string | null
} | null | undefined): ChatReference | null {
  if (!node || !Number.isInteger(node.id) || node.id < 1) return null
  if (node.kind === 'canvas_note') {
    const contentTitle = splitMindTitleBody(node.contentMd).titleRaw
    return { type: 'canvas_note', id: node.id, label: contentTitle || node.title || '画布便签' }
  }
  if (node.kind !== 'ref' || node.refId == null) return null
  if (node.refType !== 'project' && node.refType !== 'file' && node.refType !== 'event') return null
  return { type: node.refType, id: node.refId, label: node.title || '' }
}

export function useRuntimeReferenceResolver() {
  const pathFilesApi = usePathFileAccess()
  const mindStore = useMindStore()
  const projectStore = useProjectStore()
  const { t } = useI18n()

  return async (objectIds: readonly string[]) => {
    const resolved = await Promise.all(objectIds.map(async objectId => {
      const file = parseChatRuntimePathFile(objectId)
      const folder = file ? null : parseChatRuntimePathFile(objectId, 'folder')
      const path = file ?? folder
      if (path) {
        try { return await pathFilesApi.reference(path, folder ? 'folder' : 'file') }
        catch { showAppNotice(t('mindUi.referenceMissing')); return null }
      }

      const element = runtime.objects.get(objectId)?.element
      const nodeId = Number(element?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId)
      const node = Number.isInteger(nodeId)
        ? mindStore.canvasItems.find(item => item.nodeId === nodeId)?.node
        : undefined
      const reference = parseMindCanvasChatReference(node) ?? parseChatRuntimeReference(objectId)
      if (reference?.type === 'folder' || reference?.type === 'file') return null
      if (!reference || reference.label.trim()) return reference
      const nameSelector = '.fc-name, .lr-filename'
      const nameElement = element?.querySelector<HTMLElement>(nameSelector)
      const editingName = nameElement?.querySelector<HTMLInputElement>('input')?.value.trim()
      const projectName = reference.type === 'project'
        ? projectStore.projects.find(project => project.id === reference.id)?.name : undefined
      const sourceLabel = editingName || nameElement?.textContent?.trim() || projectName
      return sourceLabel ? { ...reference, label: sourceLabel } : reference
    }))
    return resolved.filter((item): item is ChatReference => item !== null)
  }
}

/** 落地收尾后源卡片会直接显形，这里等 Runtime 交还视觉所有权，再补一个短促的
 *  缩放淡入（起点与 Runtime dismiss 的 0.72 缩放一致），读感是卡片自己飞回来了。 */
export function animateSourceReturn(objectId: string) {
  const element = runtime.objects.get(objectId)?.element
  if (!element) return
  const tryAnimate = () => {
    if (runtime.isControlled(objectId)) { requestAnimationFrame(tryAnimate); return }
    // 跨 Surface 投放可能在 Runtime 的落地/取消收尾中只恢复源节点样式，
    // 没有把源卡 affordance 子树恢复到 idle。必须等控制权释放后再归一源卡视觉状态，
    // 清除操作按钮上残留的 runtime-affordances-hidden，再播放归位动画。
    runtime.applyVisualState(objectId, element, {
      phase: 'idle',
      hovered: element.matches(':hover'),
      selected: element.classList.contains('is-selected'),
      grabbed: false,
    })
    element.animate(
      [
        { opacity: 0, transform: 'scale(0.72)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, easing: 'ease-out' },
    )
  }
  requestAnimationFrame(tryAnimate)
}
