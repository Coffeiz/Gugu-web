import type { ContextLoadPolicy } from '../models.js'

const IM_SOURCES = new Set(['feishu', 'qq', 'wechat', 'telegram'])

export interface AgentContextPolicyInput {
  source?: string | null
  actorContext?: { role?: string | null } | null
  /** 兼容尚未携带 actorContext 的历史 IM 请求。 */
  imRole?: string | null
  /** Python SYSTEM_MEMORY_ENABLED 配置由可信 Host 读取后传入。 */
  memoryEnabled: boolean
}

export interface AgentContextPolicy extends ContextLoadPolicy {
  isIm: boolean
  restricted: boolean
  allowContinuityBridge: boolean
  allowMemoryReflection: boolean
}

/**
 * 依据可信入口和身份角色限制可加载的上下文。
 * Web 不因携带旧 IM 字段降权；IM member/unknown 永不读取 owner 私人上下文。
 */
export function agentContextPolicy(input: AgentContextPolicyInput): AgentContextPolicy {
  const isIm = IM_SOURCES.has(input.source ?? '')
  const role = input.actorContext ? input.actorContext.role : input.imRole
  const restricted = isIm && (role === 'member' || role === 'unknown')
  return {
    isIm,
    restricted,
    loadOwnerContext: !restricted,
    memoryEnabled: input.memoryEnabled,
    allowContinuityBridge: isIm && !restricted,
    allowMemoryReflection: !restricted,
  }
}
