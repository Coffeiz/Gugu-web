import type { PendingInteraction, RunIdentity } from '../models.js'

/** 平台无关的用户交互提示数据；Host 负责持久化和投影。 */
export interface AgentPromptSpec {
  kind: 'choice' | 'question' | 'form' | 'confirm'
  title: string
  body: string
  options: Array<{ id: string; label: string; actionType: string }>
  context: Record<string, unknown>
  secretFields?: Array<{ name: string; label: string; type: 'secret' }>
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
    if (args.secret_target || args.secret_fields) throw new Error('该交互需要可信授权处理器')
    const kind = args.kind ?? 'choice'
    if (kind !== 'choice' && kind !== 'question') throw new Error('交互类型无效')
    const raw = args.options === undefined ? [] : args.options
    if (!Array.isArray(raw) || raw.length > 8) throw new Error('交互选项无效')
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
      allowTextInput: true,
    }
  } }
}
