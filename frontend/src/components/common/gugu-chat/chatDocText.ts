// 聊天输入富文本 ⇄ 纯文本 的序列化。
// 必须递归：粘贴外部富文本常带深层嵌套（bulletList → listItem → blockquote → …），
// 只遍历两层会把嵌套内容整个丢掉——用户看得见内容、发送却成了空串且被静默吞掉。
import type { MindDocNode } from '@/composables/mind/useMindEditor'

const INLINE_TYPES = new Set(['text', 'hardBreak', 'mindRef'])

function renderNodes(nodes: MindDocNode[]): string {
  let out = ''
  let prevWasBlock = false
  for (const node of nodes) {
    const type = node.type ?? ''
    if (INLINE_TYPES.has(type)) {
      out += type === 'hardBreak' ? '\n'
        : type === 'mindRef' ? `@${node.attrs?.label ?? ''}`
        : (node.text ?? '')
      prevWasBlock = false
      continue
    }
    const inner = renderNodes(node.content ?? [])
    if (out && prevWasBlock) out += '\n'
    out += inner
    prevWasBlock = true
  }
  return out
}

export function chatTextFromDoc(doc: MindDocNode | null | undefined): string {
  return doc?.content ? renderNodes(doc.content) : ''
}
