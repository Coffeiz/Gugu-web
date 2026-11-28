/** Web Host 与桌面宿主共用聊天事件的 SSE 帧编码。 */
export function encodeAgentChatSse(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** 保留跨网络块的 UTF-8 字符和未完成的数据行。 */
export function createAgentChatSseDecoder() {
  const decoder = new TextDecoder()
  let pending = ''

  return {
    push(chunk: Uint8Array): string[] {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      return lines.flatMap(line => {
        if (!line.startsWith('data: ')) return []
        const payload = line.slice(6).trim()
        return payload ? [payload] : []
      })
    },
  }
}
