import type { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { AskUserAuthorizationPort } from '@gugu/core/tools'
import type { AgentDispatchLease } from '../run/dispatch.js'
import { readActiveSessionFilesystemGrant } from '../sandbox/authorization.js'
import { createWebAgentRagRunAuthorization } from '../rag/authorize.js'

/** 将完整沙箱授权查询限制在当前有效 Web Run、owner 与 session lease 内。 */
export function createWebAgentAskUserAuthorization(options: {
  pool: Pick<Pool, 'query'>
  lease: AgentDispatchLease
  enabled(): boolean
  now?: () => Date
}): AskUserAuthorizationPort {
  const expected = Object.freeze({ ...options.lease.identity })
  const authorization = createWebAgentRagRunAuthorization(options.pool, options.lease, { enabledAskUser: true })
  return {
    async authorization(identity: RunIdentity, signal: AbortSignal) {
      if (identity.ownerId !== expected.ownerId || identity.sessionId !== expected.sessionId || identity.runId !== expected.runId)
        throw new Error('ask_user 当前运行身份不匹配')
      if (!await authorization.authorize(identity, 'ask_user', signal)) throw new Error('ask_user 当前运行租约无效')
      signal.throwIfAborted()
      if (!options.enabled()) return 'disabled'
      const sessionId = Number(identity.sessionId)
      if (!Number.isSafeInteger(sessionId) || sessionId <= 0) throw new Error('ask_user 会话授权目标无效')
      const grant = await readActiveSessionFilesystemGrant(options.pool, identity.ownerId, sessionId, options.now?.() ?? new Date())
      signal.throwIfAborted()
      return grant ? 'already_authorized' : 'available'
    },
  }
}
