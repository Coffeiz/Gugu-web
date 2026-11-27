type AssistantMessage = { role: string; runId?: string }
type RunIdentity = { id: string }

/** 将最近加载的 runs（新到旧）映射到按时间正序排列的助手消息。 */
export function runForAssistantMessage<Run extends RunIdentity, Message extends AssistantMessage>(
  messageIndex: number,
  messages: Message[],
  runsNewestFirst: Run[],
  runDetails: Record<string, Run>,
): Run | undefined {
  const message = messages[messageIndex]
  if (message?.runId) {
    return runDetails[message.runId] ?? runsNewestFirst.find(run => run.id === message.runId)
  }
  if (!message || message.role !== 'assistant') return undefined

  const assistantOrdinal = messages
    .slice(0, messageIndex + 1)
    .filter(item => item.role === 'assistant').length - 1
  const assistantCount = messages.filter(item => item.role === 'assistant').length
  const ordinalFromNewest = assistantCount - 1 - assistantOrdinal
  return ordinalFromNewest >= 0 && ordinalFromNewest < runsNewestFirst.length
    ? runsNewestFirst[ordinalFromNewest]
    : undefined
}
