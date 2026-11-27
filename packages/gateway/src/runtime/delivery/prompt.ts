/** 平台发送前重新核验权限，拒绝时由调用方选择对应的回执。 */
export async function sendAuthorizedImPrompt<T>(
  authorize: () => Promise<boolean>, send: () => Promise<T>, rejected: T,
): Promise<T> {
  if (!await authorize()) return rejected
  return send()
}

/** 先登记投递，登记成功才发送；发送结算交由 Host 持久化。 */
export async function deliverImPrompt<T>(ports: {
  reserve(): Promise<boolean>
  authorize(): Promise<boolean>
  send(): Promise<T>
  settle(outcome: T): Promise<void>
  rejected: T
}) {
  if (!await ports.reserve()) return
  let outcome = ports.rejected
  try {
    outcome = await sendAuthorizedImPrompt(ports.authorize, ports.send, ports.rejected)
  } finally {
    await ports.settle(outcome)
  }
}

/** 原生卡片只投递可消费的单选动作，自定义回复沿用普通文本续接。 */
export function projectImChoiceButtons<T extends {
  kind?: unknown; selection_mode?: unknown; task_paused?: unknown; body?: string
  options: { id: string; token: string }[]
}>(prompt: T, includeTextHint = false): T | null {
  if (prompt.selection_mode === 'multiple' || (prompt.task_paused !== true && prompt.kind !== 'choice' && prompt.kind !== 'question'))
    return null
  const options = prompt.options.filter(option => Boolean(option.token))
  if (!options.length) return null
  if (!includeTextHint || !options.some(option => option.id === '__custom_reply__')) return { ...prompt, options }
  return { ...prompt, options, body: [prompt.body, '如需自由作答，请点击「自定义回复」后发送文字。'].filter(Boolean).join('\n') }
}
