type AssistantMessage = { role: string; runId?: string | null }
type RunIdentity = { id: string }

/** 只按消息的显式 runId 关联；确定性命令等无 Run 回复不能猜测归属。 */
export function runForAssistantMessage<Run extends RunIdentity, Message extends AssistantMessage>(
  messageIndex: number,
  messages: Message[],
  runsNewestFirst: Run[],
  runDetails: Record<string, Run>,
): Run | undefined {
  const message = messages[messageIndex]
  if (message?.role !== 'assistant' || !message.runId) return undefined
  return runDetails[message.runId] ?? runsNewestFirst.find(run => run.id === message.runId)
}
