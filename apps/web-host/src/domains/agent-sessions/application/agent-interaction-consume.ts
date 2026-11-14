import { createHash } from 'node:crypto'

export interface InteractionPromptRecord {
  id: number
  ownerId: string
  sessionId: number
  kind: string
  status: string
  expiresAt: Date
  resolvedAt: Date | null
  schema: Record<string, unknown>
}

export interface InteractionActionRecord {
  id: number
  promptId: number
  tokenHash: string
  actionType: string
  optionId: string
  context: Record<string, unknown>
  status: string
  expiresAt: Date
  consumedAt: Date | null
  consumedEventId: string | null
}

export interface InteractionConsumeTransaction {
  /** 必须同时按 prompt id 和 owner id 限定查询范围。 */
  getOwnedPrompt(ownerId: string, promptId: number): Promise<InteractionPromptRecord | null>
  /** 必须锁定匹配的动作行，直到当前事务提交或回滚。 */
  lockAction(promptId: number, tokenHash: string): Promise<InteractionActionRecord | null>
  /** 在当前数据库事务内执行一次用户归属受限的命令副作用。 */
  applyCommandAction(input: InteractionCommandActionInput): Promise<InteractionCommandActionResult>
  /** 兑换一次性确认码；false 表示确认码过期或已经使用。 */
  redeemConfirmation(ownerId: string, code: string): Promise<boolean>
  commit(): Promise<void>
}

export interface InteractionCommandActionInput {
  ownerId: string
  sessionId: number
  commandAction: 'workspace_delete' | 'filesystem_authorization_grant'
  optionId: string
  actionType: string
  context: Record<string, unknown>
  toolName: string | undefined
}

export interface InteractionCommandActionResult {
  status: 'confirmed' | 'error'
  text: string
}

export interface InteractionConsumeStore {
  /** 使用单个数据库事务执行回调；未显式提交的错误必须回滚。 */
  transaction<T>(run: (tx: InteractionConsumeTransaction) => Promise<T>): Promise<T>
}

export interface InteractionActionResult {
  kind: string
  status: string
  prompt_id: number
  option_id: string
  value: string | null
  text: string
  confirm?: boolean
}

export interface InteractionConsumeResult {
  prompt_id: number
  session_id: number
  kind: string
  option_id: string
  action_type: string
  context: Record<string, unknown>
  result: InteractionActionResult | Record<string, unknown>
  duplicate?: true
}

export interface ConsumeInteractionOptions {
  ownerId: string
  promptId: number
  token: string
  eventId?: string
  /** IM 回调适配器可以显式允许对同一事件的重放进行确认。 */
  allowDuplicateEvent?: boolean
}

export type InteractionConsumeErrorCode =
  | 'interaction_not_found'
  | 'interaction_ended'
  | 'interaction_expired'
  | 'action_invalid'
  | 'custom_reply_not_allowed'
  | 'secret_interaction_requires_private_route'
  | 'command_action_unsupported'
  | 'command_action_handler_unavailable'
  | 'confirmation_redeemer_unavailable'

export class InteractionConsumeError extends Error {
  constructor(readonly code: InteractionConsumeErrorCode, message: string) {
    super(message)
    this.name = 'InteractionConsumeError'
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function optionLabel(schema: Record<string, unknown>, optionId: string): string {
  const options = Array.isArray(schema.options) ? schema.options : []
  const option = options.find((item) => record(item).id === optionId)
  return String(record(option).label || optionId)
}

export async function consumeInteractionAction(
  store: InteractionConsumeStore,
  options: ConsumeInteractionOptions,
  now: () => Date = () => new Date(),
): Promise<InteractionConsumeResult> {
  return store.transaction(async (tx) => {
    const timestamp = now()
    const prompt = await tx.getOwnedPrompt(options.ownerId, options.promptId)
    if (!prompt) throw new InteractionConsumeError('interaction_not_found', '交互不存在')

    const action = await tx.lockAction(prompt.id, hashToken(options.token))
    const schema = record(prompt.schema)

    // IM 网关可能会在首次事务提交后重投回调；仅调用方显式允许且 token、event id 都匹配时才幂等返回。
    if (
      action && options.allowDuplicateEvent && action.status === 'consumed' &&
      options.eventId && action.consumedEventId === options.eventId
    ) {
      const resolved = record(schema.resolved_result)
      const result = Object.keys(resolved).length > 0 ? resolved : {
        kind: prompt.kind,
        status: 'awaiting_text',
        prompt_id: prompt.id,
        option_id: action.optionId,
        value: null,
        text: '自定义回复',
      }
      return {
        prompt_id: prompt.id,
        session_id: prompt.sessionId,
        kind: prompt.kind,
        option_id: action.optionId,
        action_type: action.actionType,
        context: { ...record(action.context) },
        result,
        duplicate: true,
      }
    }

    if (prompt.status !== 'active')
      throw new InteractionConsumeError('interaction_ended', '交互已结束')
    if (prompt.expiresAt.getTime() <= timestamp.getTime()) {
      prompt.status = 'expired'
      prompt.resolvedAt = timestamp
      // 与 Python 行为一致：先提交过期状态，再向调用方报告冲突。
      await tx.commit()
      throw new InteractionConsumeError('interaction_expired', '交互已过期')
    }
    if (!action || action.status !== 'pending' || action.expiresAt.getTime() <= timestamp.getTime())
      throw new InteractionConsumeError('action_invalid', '动作无效或已使用')

    const actionContext = { ...record(action.context) }
    const customReply = action.optionId === '__custom_reply__' || action.actionType === 'custom_reply'
    const promptContext = record(schema.context)
    const secretTarget = record(promptContext.secret_target)
    if (schema.secret_fields && secretTarget.kind === 'mcp_credentials') {
      throw new InteractionConsumeError(
        'secret_interaction_requires_private_route', '敏感信息交互必须通过专用入口处理',
      )
    }
    if (customReply && (schema.source !== 'agent' || !Boolean(schema.allow_text_input))) {
      throw new InteractionConsumeError('custom_reply_not_allowed', '该交互不接受自定义回答')
    }

    const cancelled = action.optionId === 'cancel' || action.actionType === 'cancel'
    const commandAction = String(actionContext.command_action || '')
    const shouldApplyCommand = !cancelled && (
      commandAction === 'workspace_delete' ||
      commandAction === 'filesystem_authorization_grant' && action.optionId === 'confirm'
    )
    const knownCommandAction = commandAction === 'workspace_delete' ||
      commandAction === 'filesystem_authorization_grant'
    if (!cancelled && commandAction && !knownCommandAction) {
      throw new InteractionConsumeError('command_action_unsupported', '该交互命令暂不支持')
    }
    if (shouldApplyCommand && typeof tx.applyCommandAction !== 'function') {
      throw new InteractionConsumeError('command_action_handler_unavailable', '交互命令处理器不可用')
    }
    const confirmCode = prompt.kind === 'confirm' && action.optionId === 'confirm'
      ? actionContext.confirm_code
      : undefined
    if (confirmCode && typeof tx.redeemConfirmation !== 'function') {
      throw new InteractionConsumeError('confirmation_redeemer_unavailable', '确认状态无法校验')
    }

    action.status = 'consumed'
    action.consumedAt = timestamp
    action.consumedEventId = options.eventId ?? null

    if (customReply) {
      prompt.schema = { ...schema, custom_input_active: true }
      const result: InteractionActionResult = {
        kind: prompt.kind,
        status: 'awaiting_text',
        prompt_id: prompt.id,
        option_id: '__custom_reply__',
        value: null,
        text: '自定义回复',
      }
      await tx.commit()
      return {
        prompt_id: prompt.id,
        session_id: prompt.sessionId,
        kind: prompt.kind,
        option_id: '__custom_reply__',
        action_type: 'custom_reply',
        context: actionContext,
        result,
      }
    }

    prompt.status = 'resolved'
    prompt.resolvedAt = timestamp
    const confirmPrompt = prompt.kind === 'confirm'
    let status = cancelled || confirmPrompt && action.optionId !== 'confirm' ? 'cancelled' : 'selected'
    let text = optionLabel(schema, action.optionId)
    if (shouldApplyCommand) {
      const commandResult = await tx.applyCommandAction({
        ownerId: options.ownerId,
        sessionId: prompt.sessionId,
        commandAction: commandAction as InteractionCommandActionInput['commandAction'],
        optionId: action.optionId,
        actionType: action.actionType,
        context: actionContext,
        toolName: typeof actionContext.tool_name === 'string' ? actionContext.tool_name : undefined,
      })
      if (
        (commandResult.status !== 'confirmed' && commandResult.status !== 'error') ||
        typeof commandResult.text !== 'string'
      ) {
        throw new InteractionConsumeError('command_action_handler_unavailable', '交互命令处理器返回无效结果')
      }
      status = commandResult.status
      text = commandResult.text
    }
    const result: InteractionActionResult = {
      kind: prompt.kind,
      status,
      prompt_id: prompt.id,
      option_id: action.optionId,
      value: action.optionId,
      text,
    }
    if (confirmPrompt) {
      if (status !== 'error') {
        result.status = status === 'cancelled' ? 'cancelled' : 'confirmed'
        result.confirm = result.status === 'confirmed'
      }
      if (confirmCode && status !== 'error') {
        const redeemed = await tx.redeemConfirmation(options.ownerId, String(confirmCode))
        if (!redeemed) {
          result.status = 'error'
          result.confirm = false
          result.text = '确认已过期，请让助手重新发起操作。'
        }
      }
    }
    prompt.schema = { ...schema, resolved_result: result }
    await tx.commit()
    return {
      prompt_id: prompt.id,
      session_id: prompt.sessionId,
      kind: prompt.kind,
      option_id: action.optionId,
      action_type: action.actionType,
      context: actionContext,
      result,
    }
  })
}
