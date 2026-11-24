/** 群聊只回执发送状态，记忆正文只能投递给已经核验的所有者。 */
export async function replyToImMemoryCommand(input: {
  chatType: 'group' | 'c2c'
  signal: AbortSignal
  authorizeOwner(): Promise<boolean>
  readMemory(): Promise<string>
  sendOwnerPrivate?(text: string): Promise<boolean>
}): Promise<string> {
  const denied = '只有绑定 Bot 的用户可以查看个人记忆。'
  input.signal.throwIfAborted()
  if (!await input.authorizeOwner()) return denied
  const privateHint = '请在私聊中查看个人记忆。'
  const read = async () => await input.readMemory() || '当前没有已保存的个人记忆。'
  if (input.chatType === 'group') {
    if (!input.sendOwnerPrivate) return privateHint
    try {
      const memory = await read()
      input.signal.throwIfAborted()
      if (await input.authorizeOwner() && await input.sendOwnerPrivate(memory)) return '已私聊发送个人记忆。'
    } catch { input.signal.throwIfAborted() }
    return privateHint
  }
  const memory = await read()
  input.signal.throwIfAborted()
  return await input.authorizeOwner() ? memory : denied
}
