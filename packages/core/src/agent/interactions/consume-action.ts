import { advanceQuestionBatch, questionBatchText, QUESTION_BATCH_CANCEL, QUESTION_BATCH_SUBMIT, readQuestionBatch, validateQuestionAnswers, type AskQuestionAnswer } from './question-batch.js'
import { parseEmailComposeSubmission, type EmailComposeSubmission } from './email-compose.js'
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
  selected_option_ids?: string[]
  question_index?: number
  answers?: AskQuestionAnswer[]
  email_submission?: EmailComposeSubmission
  custom_answer?: string
  value: string | string[] | null
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
  selectedOptionIds?: readonly string[]
  customAnswer?: string
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
    const questions = readQuestionBatch(schema)
    if (questions && schema.source === 'agent' && actionContext.tool_name === 'ask_user') {
      if (action.actionType === 'question_step') {
        const match = /^__question_([0-4])_([0-7])__$/u.exec(action.optionId)
        const index = Number(match?.[1])
        const question = questions[index], option = question?.options?.[Number(match?.[2])]
        const current = Array.isArray(schema.question_progress) ? schema.question_progress.length : 0
        if (!option || index !== current || !options.eventId || options.customAnswer !== undefined || options.selectedOptionIds !== undefined)
          throw new InteractionConsumeError('action_invalid', '该问题已经处理，请回答当前题目')
        const progress = advanceQuestionBatch(schema, questions, { question_id: question.id, option_ids: [option.id] }, options.eventId, timestamp)
        const result: InteractionActionResult = {
          kind: prompt.kind, status: progress.complete ? 'answered' : 'question_next', prompt_id: prompt.id,
          option_id: action.optionId, value: null, text: progress.complete ? '已提交全部答案' : questionBatchText(questions, current + 1),
          ...(progress.complete ? { answers: progress.answers } : { question_index: current + 1 }),
        }
        action.status = 'consumed'
        action.consumedAt = timestamp
        action.consumedEventId = options.eventId
        prompt.schema = progress.complete ? { ...progress.schema, resolved_result: result } : progress.schema
        if (progress.complete) {
          prompt.status = 'resolved'
          prompt.resolvedAt = timestamp
        }
        await tx.commit()
        return { prompt_id: prompt.id, session_id: prompt.sessionId, kind: prompt.kind,
          option_id: action.optionId, action_type: action.actionType, context: actionContext, result }
      }
      const cancelled = action.optionId === QUESTION_BATCH_CANCEL && action.actionType === 'cancel'
      let answers: AskQuestionAnswer[] | null = null
      if (action.optionId === QUESTION_BATCH_SUBMIT && action.actionType === 'question_batch'
        && typeof options.customAnswer === 'string' && Buffer.byteLength(options.customAnswer) <= 55_000) {
        try { answers = validateQuestionAnswers(questions, JSON.parse(options.customAnswer)) } catch { /* 返回统一的回答校验错误。 */ }
      }
      if (options.selectedOptionIds !== undefined || (cancelled ? options.customAnswer !== undefined : !answers))
        throw new InteractionConsumeError('action_invalid', '请为每道题提交有效答案')
      const result: InteractionActionResult = { kind: prompt.kind, status: cancelled ? 'cancelled' : 'answered',
        prompt_id: prompt.id, option_id: action.optionId, value: null, text: cancelled ? '已取消问答' : '已提交全部答案',
        ...(answers ? { answers } : {}) }
      action.status = 'consumed'
      action.consumedAt = timestamp
      action.consumedEventId = options.eventId ?? null
      prompt.status = 'resolved'
      prompt.resolvedAt = timestamp
      prompt.schema = { ...schema, resolved_result: result }
      await tx.commit()
      return { prompt_id: prompt.id, session_id: prompt.sessionId, kind: prompt.kind,
        option_id: action.optionId, action_type: action.actionType, context: actionContext, result }
    }
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

    const customAnswer = typeof options.customAnswer === 'string' ? options.customAnswer.trim() : ''
    const emailCompose = schema.source === 'agent' && prompt.kind === 'confirm' && promptContext.tool_name === 'send_email'
      ? record(promptContext.email_compose) : {}
    const emailSubmit = emailCompose.enabled === true && action.optionId === 'confirm' && action.actionType === 'confirm'
    const editedEmail = emailSubmit ? parseEmailComposeSubmission(options.customAnswer) : null
    const accounts = Array.isArray(emailCompose.accounts) ? emailCompose.accounts.map(record) : []
    const sender = editedEmail?.account ? accounts.find(account => account.id === editedEmail.account)?.email : emailCompose.sender
    if (emailSubmit && (!editedEmail || typeof sender !== 'string' || !sender
      || editedEmail.action === 'draft' && (emailCompose.canDraft !== true || !editedEmail.account)))
      throw new InteractionConsumeError('action_invalid', '邮件表单无效，请核对地址、主题和正文')
    const emailSubmission = editedEmail ? { ...editedEmail, senderAddress: String(sender) } : null
    const multiplePrompt = schema.selection_mode === 'multiple' && schema.source === 'agent' &&
      (prompt.kind === 'choice' || prompt.kind === 'question') && !actionContext.command_action
    if (options.customAnswer !== undefined && !emailSubmission && (!multiplePrompt || !schema.allow_text_input ||
      !customAnswer || Buffer.byteLength(customAnswer) > 8_000))
      throw new InteractionConsumeError('action_invalid', '自定义回复无效')
    const multiple = multiplePrompt && action.actionType === 'choice' && !customReply
    const customOnly = multiplePrompt && customReply && Boolean(customAnswer)
    const supplied = options.selectedOptionIds
    if (supplied !== undefined && (!multiple || !Array.isArray(supplied)))
      throw new InteractionConsumeError('action_invalid', '多选选项无效')
    const choices = multiple && Array.isArray(schema.options)
      ? new Set(schema.options.map(record).filter(option => option.action_type === 'choice').map(option => option.id))
      : new Set()
    const selectedIds = multiple ? [...new Set(supplied ?? [action.optionId])] : undefined
    if (selectedIds && (!selectedIds.includes(action.optionId) || selectedIds.some(id => !choices.has(id)))) throw new InteractionConsumeError('action_invalid', '多选选项无效')

    const cancelled = !multiple && (action.optionId === 'cancel' || action.actionType === 'cancel')
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

    if (customReply && !customOnly) {
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
    let text = selectedIds ? selectedIds.map(id => optionLabel(schema, id)).join('、') : optionLabel(schema, action.optionId)
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
      ...(selectedIds ? { selected_option_ids: selectedIds } : {}),
      ...(emailSubmission ? { email_submission: emailSubmission } : customAnswer ? { custom_answer: customAnswer } : {}),
      value: selectedIds ?? (customOnly ? customAnswer : action.optionId),
      text: customAnswer && !emailSubmission ? [customOnly ? '' : text, customAnswer].filter(Boolean).join('\n') : text,
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
