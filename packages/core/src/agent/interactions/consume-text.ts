export interface InteractionTextPrompt {
  id: number
  ownerId: string
  sessionId: number
  kind: string
  status: string
  expiresAt: Date
  resolvedAt: Date | null
  schema: Record<string, unknown>
}

export interface InteractionTextTransaction {
  getOwnedPrompt(ownerId: string, promptId: number): Promise<InteractionTextPrompt | null>
  /** 恢复记录必须和 prompt 结果在同一事务提交。 */
  enqueueResume?(prompt: InteractionTextPrompt, eventId?: string): Promise<void>
  commit(): Promise<void>
}

export interface InteractionTextStore {
  transaction<T>(run: (tx: InteractionTextTransaction) => Promise<T>): Promise<T>
}

export interface InteractionTextOptions {
  ownerId: string
  promptId: number
  text: string
  eventId?: string
}

export type InteractionTextErrorCode =
  | 'interaction_not_found'
  | 'interaction_expired'
  | 'secret_interaction_requires_private_route'
  | 'custom_reply_not_allowed'
  | 'custom_reply_must_be_selected'
  | 'text_invalid'

export class InteractionTextError extends Error {
  constructor(readonly code: InteractionTextErrorCode, message: string) {
    super(message)
    this.name = 'InteractionTextError'
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** 按 Python consume_text 语义消费一次 ask_user 文本，并原子写入 Node Run 恢复队列。 */
export async function consumeInteractionText(
  store: InteractionTextStore,
  options: InteractionTextOptions,
  now: () => Date = () => new Date(),
) {
  return store.transaction(async tx => {
    const prompt = await tx.getOwnedPrompt(options.ownerId, options.promptId)
    if (!prompt) throw new InteractionTextError('interaction_not_found', '交互不存在')

    const timestamp = now()
    if (prompt.status !== 'active' || prompt.expiresAt.getTime() <= timestamp.getTime()) {
      prompt.status = 'expired'
      prompt.resolvedAt = timestamp
      await tx.commit()
      throw new InteractionTextError('interaction_expired', '交互已过期')
    }

    const schema = record(prompt.schema)
    const context = record(schema.context)
    const target = record(context.secret_target)
    if (schema.secret_fields && target.kind === 'mcp_credentials') {
      throw new InteractionTextError('secret_interaction_requires_private_route', '敏感信息交互必须通过专用入口处理')
    }
    if (schema.source !== 'agent' || schema.allow_text_input !== true) {
      throw new InteractionTextError('custom_reply_not_allowed', '该交互不接受文本回答')
    }
    const optionsList = Array.isArray(schema.options) ? schema.options : []
    const realOptions = optionsList.filter(item => record(item).id !== '__custom_reply__')
    if (realOptions.length > 0 && schema.custom_input_active !== true) {
      throw new InteractionTextError('custom_reply_must_be_selected', '请先选择自定义回答')
    }
    const text = options.text.trim()
    const length = Array.from(text).length
    if (!text || length > 2000) throw new InteractionTextError('text_invalid', '回答不能为空或过长')

    const result = { kind: prompt.kind, status: 'answered', prompt_id: prompt.id, option_id: null, value: null, text }
    prompt.status = 'resolved'
    prompt.resolvedAt = timestamp
    prompt.schema = { ...schema, resolved_result: result }
    if (typeof context.tool_call_id === 'string' && context.tool_call_id) {
      if (!tx.enqueueResume) throw new Error('交互恢复服务不可用')
      await tx.enqueueResume(prompt, options.eventId)
    }
    await tx.commit()
    return { prompt_id: prompt.id, session_id: prompt.sessionId, kind: prompt.kind, context: { ...context }, result, event_id: options.eventId }
  })
}
