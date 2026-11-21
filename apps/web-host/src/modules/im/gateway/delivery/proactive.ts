/** 调度器先绑定并校验目标，主动投递使用同一平台发送端口和执行租约。 */
export async function sendProactiveIm(
  send: (() => Promise<string>) | undefined, assertLease?: () => Promise<void>,
): Promise<string> {
  if (!send) return 'Node 服务暂未接入该投递渠道'
  await assertLease?.()
  return send()
}

/** 固定提醒的文案直接作为平台消息正文。 */
export function proactiveImText(message: { title: string; text: string; plainText?: boolean }): string {
  return message.plainText ? message.text : `⏰ ${message.title}\n\n${message.text}`
}
