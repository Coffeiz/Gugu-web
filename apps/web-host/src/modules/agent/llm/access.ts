import { createHmac } from 'node:crypto'
import { contextAccessScopeHash, type ContextSourceSelection, type HistoryIdentity } from '@gugu/core/agent'
/** 仅使用可信版本号，不把密钥或配置原文用于身份计算。 */
export function agentAccessScopeHash(secret: string, ownerId: string, revisions: { permissions: string; model: string; credentials: string }, contextBinding = 'owner'): string {
  if (!secret || !ownerId || !revisions.permissions || !revisions.model || !revisions.credentials) throw new TypeError('访问范围版本无效')
  if (!contextBinding) throw new TypeError('上下文绑定无效')
  return createHmac('sha256', secret).update(JSON.stringify(['agent-access-scope-v1', ownerId, contextBinding, revisions.permissions, revisions.model, revisions.credentials])).digest('hex')
}

/** 返回同时交给来源选择与 Provider 的范围身份；key 只包含不透明版本摘要。 */
export function agentContextAccessScope(secret: string, identity: HistoryIdentity, selection: Pick<ContextSourceSelection, 'groupChat' | 'contextPolicy'>, revisions: { permissions: string; model: string; credentials: string }, digest: (value: unknown) => string, contextBinding: string) {
  const contextScopeKey = agentAccessScopeHash(secret, identity.ownerId, revisions, contextBinding)
  const scopedSelection = { ...selection, contextScopeKey }
  return { contextScopeKey, accessScopeHash: contextAccessScopeHash(identity, scopedSelection, digest) }
}
