// 聊天输入富文本 ⇄ 文本 的序列化。
// 必须递归：粘贴外部富文本常带深层嵌套（bulletList → listItem → blockquote → …），
// 只遍历两层会把嵌套内容整个丢掉——用户看得见内容、发送却成了空串且被静默吞掉。
// 2026-09-08 起行内标记/块级结构序列化成 markdown 语法（**加粗**、`代码`、- 列表、
// ``` 围栏……），气泡端 renderChatMd 再渲染回来；之前标记在这里被丢成纯文本，
// 输入框里排好的加粗发出去就没了。mindRef 保持聊天口径 @label（笔记存储用的
// [[type:id|label]] 语法不进聊天文本）。输入框本体不做 md 渲染，保持富文本编辑。
import type { MindDocNode } from '@/composables/mind/useMindEditor'
import { wrapMd } from '@/composables/mind/useMindEditor'

function inlineToChatMd(nodes: MindDocNode[] = []): string {
  return nodes.map(n => {
    if (n.type === 'mindRef') return `@${n.attrs?.label ?? ''}`
    if (n.type === 'hardBreak') return '\n'
    return wrapMd(n.text ?? '', n.marks)
  }).join('')
}

function renderBlocks(nodes: MindDocNode[], indent = ''): string[] {
  const out: string[] = []
  for (const node of nodes) {
    const type = node.type ?? ''
    if (type === 'heading') {
      out.push(indent + '# ' + inlineToChatMd(node.content))
    } else if (type === 'codeBlock') {
      // 代码块内容是纯文本（TipTap 禁止代码块内套行内标记），不走 inlineToChatMd
      const code = (node.content ?? []).map(n => n.text ?? '').join('')
      const lang = node.attrs?.language ?? ''
      out.push(indent + '```' + lang)
      for (const line of code.split('\n')) out.push(indent + line)
      out.push(indent + '```')
    } else if (type === 'blockquote') {
      for (const p of node.content ?? []) {
        for (const line of inlineToChatMd(p.content).split('\n')) out.push(indent + '> ' + line)
      }
    } else if (type === 'bulletList') {
      for (const item of node.content ?? []) {
        // 条目自身不带缩进；续行由列表层补缩进，嵌套列表/多段落才能正确嵌进条目下
        const body = renderBlocks(item.content ?? [])
        out.push(indent + '- ' + (body.shift() ?? ''))
        for (const line of body) out.push(indent + '  ' + line)
      }
    } else if (type === 'orderedList') {
      let index = 0
      for (const item of node.content ?? []) {
        index++
        const body = renderBlocks(item.content ?? [])
        out.push(indent + `${index}. ` + (body.shift() ?? ''))
        for (const line of body) out.push(indent + '   ' + line)
      }
    } else if (type === 'taskList') {
      for (const item of node.content ?? []) {
        const body = renderBlocks(item.content ?? [])
        const box = item.attrs?.checked ? 'x' : ' '
        out.push(indent + `- [${box}] ` + (body.shift() ?? ''))
        for (const line of body) out.push(indent + '  ' + line)
      }
    } else if (type === 'horizontalRule') {
      out.push(indent + '---')
    } else if (type === 'hardBreak') {
      out.push('')
    } else {
      // paragraph 及行内兜底；空段落是用户专门敲的空行，要保留成空行
      out.push(indent + inlineToChatMd(node.content ?? []))
    }
  }
  return out
}

export function chatTextFromDoc(doc: MindDocNode | null | undefined): string {
  return doc?.content ? renderBlocks(doc.content).join('\n') : ''
}
