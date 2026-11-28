import { questionStepOptionId } from './question-batch.js'
import type { PendingInteraction } from '../models.js'
import type { AgentPromptSpec } from './prompt-description.js'
import { normalizeSecretFields } from './secrets.js'

function validate(spec: AgentPromptSpec, request: PendingInteraction): Array<{ name: string; label: string; type: 'secret' }> {
  if (!['choice', 'question', 'form', 'confirm'].includes(spec.kind) || typeof spec.title !== 'string' || typeof spec.body !== 'string' || !Array.isArray(spec.options) || spec.options.length > 8) throw new Error('交互内容无效')
  if (spec.options.some(option => !option.id || option.id.length > 64 || !option.label || option.label.length > 120 || !option.actionType)) throw new Error('交互选项无效')
  if (new Set(spec.options.map(option => option.id)).size !== spec.options.length) throw new Error('交互选项重复')
  if (spec.selectionMode === 'multiple' && (request.kind !== 'question' || !spec.options.length || spec.options.some(option => option.id === '__custom_reply__' || option.actionType !== 'choice'))) throw new Error('多选交互需要选项')
  const fields = spec.secretFields ?? []
  if (request.kind === 'credential') {
    const target = spec.context.secret_target as Record<string, unknown> | undefined
    if (spec.kind !== 'form' || target?.kind !== 'mcp_credentials' || typeof target.server_id !== 'string') throw new Error('凭据交互目标无效')
    const normalized = normalizeSecretFields(fields)
    if (!normalized) throw new Error('凭据字段无效')
    return normalized
  } else if (fields.length) throw new Error('交互类型不匹配')
  if (request.kind === 'confirmation' && spec.kind !== 'confirm') throw new Error('交互类型不匹配')
  if (request.kind === 'question' && !['question', 'choice'].includes(spec.kind)) throw new Error('交互类型不匹配')
  return []
}

/** 持久化前统一校验交互提示并生成动作描述。 */
export function prepareAgentInteractionPrompt(spec: AgentPromptSpec, request: PendingInteraction, now: number) {
  const secretFields = validate(spec, request)
  const minutes = Math.max(1, Math.min(spec.expiresMinutes ?? 10, 30))
  if (!Number.isFinite(minutes)) throw new Error('交互有效期无效')
  const expiry = new Date(now + minutes * 60_000)
  const secret = request.kind === 'credential'
  const allowText = request.kind === 'question' && Boolean(spec.allowTextInput)
  const options = [...spec.options, ...(allowText ? [{ id: '__custom_reply__', label: '自定义回复', actionType: 'custom_reply' }] : [])]
  if (spec.serialQuestions) for (const [step, question] of (spec.questions ?? []).entries()) {
    for (const [index, option] of (question.options ?? []).entries())
      options.push({ id: questionStepOptionId(step, index), label: option.label, actionType: 'question_step' })
  }
  const context = { ...spec.context, tool_call_id: request.toolCall.id, tool_name: request.toolCall.name }
  const schema = {
    options: options.map(option => ({ id: option.id, label: option.label, action_type: option.actionType })),
    ...(spec.questions ? { questions: spec.questions } : {}),
    ...(spec.selectionMode === 'multiple' ? { selection_mode: spec.selectionMode } : {}),
    secret_fields: secretFields, allow_text_input: allowText, source: 'agent', custom_input_active: false, context,
  }
  return { expiry, secret, options, context, schema }
}
