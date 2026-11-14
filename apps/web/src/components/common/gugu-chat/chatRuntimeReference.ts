import type { ChatReference } from './chatTypes'
import { splitMindTitleBody } from '@/composables/mind/useMindEditor'

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
