import type { ChatMessage } from './chatTypes'

export function projectChatRows(messages: readonly ChatMessage[]) {
  const rows: { msg: ChatMessage; messageIndex: number; tools?: ChatMessage[] }[] = []
  const rowIndexByMessageIndex: number[] = []
  let openGroupIndex: number | undefined
  for (const [messageIndex, msg] of messages.entries()) {
    if (msg.role === 'tool') {
      if (openGroupIndex === undefined || rows[openGroupIndex]!.msg.runId !== msg.runId) {
        openGroupIndex = rows.length
        rows.push({ msg, messageIndex, tools: [] })
      }
      rows[openGroupIndex]!.tools!.push(msg)
      rowIndexByMessageIndex.push(openGroupIndex)
    } else {
      rowIndexByMessageIndex.push(rows.length)
      rows.push({ msg, messageIndex })
      const emptyReply = msg.role === 'ai' && msg.streaming && !msg.text.trim()
        && !msg.files?.length && !msg.linkButtons?.buttons.length
      if (msg.role !== 'interaction' && !emptyReply) openGroupIndex = undefined
    }
  }
  return { rows, rowIndexByMessageIndex, openGroupIndex }
}

export function toolActivityLabel(msg: ChatMessage, translate: (key: string) => string, exists: (key: string) => boolean) {
  const name = msg.toolName || ''
  const key = `toolNames.${name}`
  return msg.toolLabelOverride?.trim() || (name && exists(key) ? translate(key) : msg.toolLabel?.trim() || name || translate('chatUi.toolCall'))
}
