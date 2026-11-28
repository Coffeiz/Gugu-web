import { Fragment, Slice, type ResolvedPos } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

/**
 * 聊天输入框只消费剪贴板纯文本，并直接生成文档事务。
 * 不重放原 ClipboardEvent，避免已 preventDefault 的事件再次进入 handlePaste 后被当成
 * 已处理事件吞掉；富文本剪贴板也不会把 HTML 样式带进聊天草稿。
 */
export function pastePlainTextClipboard(event: ClipboardEvent, view: EditorView): boolean {
  const clipboard = event.clipboardData
  if (!clipboard) return false
  const text = clipboard.getData('text/plain') || clipboard.getData('Text')
  if (!text) return false

  let slice = parseChatClipboardText(text, view.state.selection.$from, true, view)
  view.someProp('transformPasted', transform => {
    slice = transform(slice, view, true)
  })
  const transaction = view.state.tr
    .replaceSelection(slice)
    .scrollIntoView()
    .setMeta('paste', true)
    .setMeta('uiEvent', 'paste')
  view.dispatch(transaction)
  event.preventDefault()
  return true
}

/**
 * 按聊天草稿的存储结构逐行解析剪贴板纯文本。
 * ProseMirror 默认会把连续换行合并为一个段落边界，导致长 Markdown 粘贴时空行丢失。
 */
export function parseChatClipboardText(
  text: string,
  _context: ResolvedPos,
  _plain: boolean,
  view: EditorView,
): Slice {
  const { schema } = view.state
  const paragraph = schema.nodes.paragraph
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks = lines.map(line => paragraph.create(null, line ? schema.text(line) : null))
  return new Slice(Fragment.fromArray(blocks), 0, 0)
}
