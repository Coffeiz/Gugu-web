import type { PoolClient } from 'pg'
import type { PendingInteraction, RunIdentity } from '@gugu/core/agent'
import type { AgentPromptActivationPorts, AgentPromptSpec } from './persistence/agent-interaction-activate-postgres.js'

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
/** 确认与凭据必须由可信业务适配器提供，模型参数不能授予权限或指定凭据目标。 */
export function createAgentInteractionDescription(trusted: {
  confirmation(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec>
  credential(client: PoolClient, identity: RunIdentity, request: PendingInteraction): Promise<AgentPromptSpec>
}): AgentPromptActivationPorts {
  return { async describe(client, identity, request) {
    if (request.kind === 'confirmation') return trusted.confirmation(client, identity, request)
    if (request.kind === 'credential') return trusted.credential(client, identity, request)
    if (request.toolCall.name !== 'ask_user') throw new Error('交互工具不支持')
    const args = object(request.toolCall.input)
    if (args.authorization || args.secret_target || args.secret_fields) throw new Error('该交互需要可信授权处理器')
    const kind = args.kind ?? 'choice'
    if (kind !== 'choice' && kind !== 'question') throw new Error('交互类型无效')
    const raw = args.options === undefined ? [] : args.options
    if (!Array.isArray(raw) || raw.length > 8) throw new Error('交互选项无效')
    const options = raw.map(value => {
      const option = object(value), id = typeof option.id === 'string' ? option.id.trim() : '', label = typeof option.label === 'string' ? option.label.trim() : ''
      if (!id || id.length > 64 || !label || label.length > 120) throw new Error('交互选项无效')
      return { id, label, actionType: 'choice' }
    })
    return { kind, title: typeof args.title === 'string' ? args.title.trim().slice(0, 120) : '需要你的选择', body: typeof args.body === 'string' ? args.body.trim().slice(0, 1000) : '', options, context: {}, allowTextInput: true }
  } }
}
