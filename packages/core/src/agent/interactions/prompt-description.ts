import { askQuestionBatchSchema, QUESTION_BATCH_CANCEL, QUESTION_BATCH_SUBMIT, type AskQuestion } from './question-batch.js'
import type { PendingInteraction, RunIdentity } from '../models.js'

/** 平台无关的用户交互提示数据；Host 负责持久化和投影。 */
export interface AgentPromptSpec {
  kind: 'choice' | 'question' | 'form' | 'confirm'
  title: string
  body: string
  options: Array<{ id: string; label: string; actionType: string }>
  context: Record<string, unknown>
  secretFields?: Array<{ name: string; label: string; type: 'secret' }>
  questions?: AskQuestion[]
  serialQuestions?: boolean
  selectionMode?: 'multiple'
  allowTextInput?: boolean
  expiresMinutes?: number
}

export interface AgentTrustedPromptDescriptions<Client> {
  confirmation(client: Client, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec>
  credential(client: Client, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec>
  authorization(client: Client, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec>
}

export interface AgentPromptDescriptionPorts<Client> {
  describe(client: Client, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec>
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Core owns the cross-platform ask_user contract and dispatches trusted prompts
 * to Host adapters. Model input cannot declare authorization or secret targets.
 */
export function createAgentInteractionDescription<Client>(
  trusted: AgentTrustedPromptDescriptions<Client>,
  policy: { singleChoiceOnly?: boolean; allowQuestionBatch?: boolean } = {},
): AgentPromptDescriptionPorts<Client> {
  return { async describe(client, identity, request) {
    if (request.kind === 'confirmation') return trusted.confirmation(client, identity, request)
    if (request.kind === 'credential') return trusted.credential(client, identity, request)
    if (request.toolCall.name !== 'ask_user') throw new Error('交互工具不支持')
    const args = object(request.toolCall.input)
    if (args.authorization !== undefined) {
      if (args.authorization !== 'user_sandbox') throw new Error('该交互需要可信授权处理器')
      return trusted.authorization(client, identity, request)
    }
    return describeAskUserPrompt(args, policy)
  } }
}

export const imAskUserPolicy = Object.freeze({ singleChoiceOnly: true, allowQuestionBatch: false })

export function describeAskUserPrompt(input: unknown, policy: { singleChoiceOnly?: boolean; allowQuestionBatch?: boolean } = {}): AgentPromptSpec {
  const args = object(input)
  if (args.authorization !== undefined || args.secret_target || args.secret_fields) throw new Error('该交互需要可信授权处理器')
  if (args.kind === 'questions') {
    if (policy.allowQuestionBatch === false) throw new Error('当前入口一次只能问一道题')
    return describeQuestionBatch(args, policy.singleChoiceOnly)
  }
  const kind = args.kind ?? 'choice'
  if (kind !== 'choice' && kind !== 'question') throw new Error('交互类型无效')
  const multiple = !policy.singleChoiceOnly && args.selection_mode === 'multiple'
  const raw = args.options === undefined ? [] : args.options
  if (!Array.isArray(raw) || raw.length > 8 || (multiple && !raw.length)) throw new Error('交互选项无效')
  const options = raw.map(value => {
    const option = object(value), id = typeof option.id === 'string' ? option.id.trim() : '', label = typeof option.label === 'string' ? option.label.trim() : ''
    if (!id || id.length > 64 || !label || label.length > 120) throw new Error('交互选项无效')
    return { id, label, actionType: 'choice' }
  })
  return {
    kind,
    title: typeof args.title === 'string' ? args.title.trim().slice(0, 120) : '需要你的选择',
    body: typeof args.body === 'string' ? args.body.trim().slice(0, 1000) : '',
    options,
    context: {},
    ...(multiple ? { selectionMode: 'multiple' as const } : {}),
    allowTextInput: true,
  }
}

export function describeQuestionBatch(args: Record<string, unknown>, serial = false): AgentPromptSpec {
  if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('问答标题无效')
  const questions = askQuestionBatchSchema(serial).parse(args.questions).map(question =>
    serial ? { ...question, selection_mode: 'single' as const } : question)
  return { kind: 'question', title: args.title.trim().slice(0, 120), body: '', questions, serialQuestions: serial,
    options: [{ id: QUESTION_BATCH_SUBMIT, label: '提交答案', actionType: 'question_batch' },
      { id: QUESTION_BATCH_CANCEL, label: '取消问答', actionType: 'cancel' }], context: {},
    allowTextInput: false }
}

/** 只用可信服务配置生成表单，不投影凭据值。 */
export function describeMcpCredentialPrompt(server: {
  id: string; name: string; credentialSlots: unknown; configurationVersion?: string
}): AgentPromptSpec {
  const slots: unknown[] = Array.isArray(server.credentialSlots) ? server.credentialSlots : []
  const fields = slots.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('凭据槽位无效')
    const slot = value as Record<string, unknown>, name = slot.id, label = slot.label
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || typeof label !== 'string' || !label.trim() || label.length > 120) throw new Error('凭据槽位无效')
    return { name, label: label.trim(), type: 'secret' as const }
  })
  if (!fields.length || fields.length > 16 || new Set(fields.map(field => field.name)).size !== fields.length) throw new Error('凭据槽位无效')
  return { kind: 'form', title: '补全 MCP 凭据', body: `MCP 服务 [${String(server.name).slice(0, 64)}] 需要凭据，值只会加密保存。`, options: [],
    secretFields: fields, context: { secret_target: { kind: 'mcp_credentials', server_id: server.id,
      ...(server.configurationVersion ? { configuration_version: server.configurationVersion } : {}) } } }
}
