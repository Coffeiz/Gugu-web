import { agentOwnerSessionKey, createSqlAgentOwnerSessionBindings } from '@gugu/core/agent-sessions'
import type { RunIdentity } from '@gugu/core/agent'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createFeishuBotApi, isFeishuMessageId } from '@gugu/core/im/feishu-bot-api'
import type { ProviderTransport } from '@gugu/core/providers'
import type { Pool } from 'pg'
import { createAgentImTools, type AgentImToolPorts } from '@gugu/core/tools'
import { createRedisImOwnerSessionBindings } from '../../../adapters/redis-events.js'
import { readEnabledFeishuBot } from '../../im/feishu-bot.js'

type PrivateOwner = NonNullable<AgentImToolPorts['ownerSession']>['privateOwner']

/** 供实时 IM Host 按可信 Run 装配。身份解析可以借用绑定操作的数据库事务。 */
export function createWebAgentImOwnerSessions(options: {
  core: SqlDataRuntime
  redisUrl: string
  privateOwner(identity: RunIdentity, signal: AbortSignal, database: SqlDataRuntime['db']): ReturnType<PrivateOwner>
}) {
  if (!options.redisUrl.trim()) throw new Error('IM 私聊会话绑定需要 Redis')
  const { db, backend } = options.core
  const redis = createRedisImOwnerSessionBindings(options.redisUrl)
  const routing = createSqlAgentOwnerSessionBindings(db, backend, redis, options.privateOwner)
  return {
    readWebSession: routing.readWebSession,
    async forRun(identity: RunIdentity, signal: AbortSignal) {
      identity = Object.freeze({ ...identity })
      signal.throwIfAborted()
      const initial = await options.privateOwner(identity, signal, db)
      signal.throwIfAborted()
      const key = initial && agentOwnerSessionKey(identity.ownerId, initial)
      if (!key) return null
      const privateOwner = async (candidate: RunIdentity, signal: AbortSignal, database = db) => {
        if (identity.ownerId !== candidate.ownerId || identity.sessionId !== candidate.sessionId || identity.runId !== candidate.runId) return null
        const current = await options.privateOwner(identity, signal, database)
        signal.throwIfAborted()
        return current && agentOwnerSessionKey(identity.ownerId, current) === key ? current : null
      }
      const { bind } = createSqlAgentOwnerSessionBindings(db, backend, redis, privateOwner)
      return {
        tools: createAgentImTools({ ownerSession: { privateOwner, bind } }),
        authorize: async (candidate: RunIdentity, candidateSignal: AbortSignal) => Boolean(await privateOwner(candidate, candidateSignal)),
      }
    },
  }
}

type Reaction = NonNullable<AgentImToolPorts['reaction']>

/** Gateway 提供当前入站消息与回应标记，平台传输只调用该 owner 当下可用的 Bot。 */
export function createWebAgentFeishuReaction(options: {
  pool: Pick<Pool, 'query'>
  transport: ProviderTransport
  decrypt(value: string): Promise<string> | string
  /** 由认证后的 Gateway 在每次读取时检查当前消息和平台可用性。 */
  currentTarget: Reaction['target']
  markReacted(identity: RunIdentity, target: Parameters<Reaction['react']>[1]): Promise<void>
}) {
  const api = createFeishuBotApi(options.transport)
  return async (identity: RunIdentity, signal: AbortSignal) => {
    identity = Object.freeze({ ...identity })
    signal.throwIfAborted()
    const selected = await options.currentTarget(identity, signal)
    signal.throwIfAborted()
    if (selected?.platform !== 'feishu' || !/^[1-9]\d{0,9}$/u.test(selected.channelId)
      || !isFeishuMessageId(selected.messageId)) return null
    const target = Object.freeze({ ...selected })
    const botId = Number(target.channelId)
    if (botId > 2_147_483_647) return null
    async function permitted(candidate: RunIdentity, signal: AbortSignal) {
      signal.throwIfAborted()
      if (candidate.ownerId !== identity.ownerId || candidate.sessionId !== identity.sessionId || candidate.runId !== identity.runId) return null
      const current = await options.currentTarget(identity, signal)
      if (current?.platform !== target.platform || current.channelId !== target.channelId || current.messageId !== target.messageId) return null
      const bot = await readEnabledFeishuBot(options.pool, identity.ownerId, botId)
      signal.throwIfAborted()
      return bot?.app_id && bot.app_secret ? bot : null
    }
    if (!await permitted(identity, signal)) return null
    const reaction: Reaction = {
      async target(candidate, signal) { return await permitted(candidate, signal) ? target : null },
      async react(candidate, _target, emoji, signal) {
        const bot = await permitted(candidate, signal)
        if (!bot) return 'rejected'
        let token: string
        try { token = await api.tenantToken(bot.app_id, await options.decrypt(bot.app_secret), signal) }
        catch {
          signal.throwIfAborted()
          return 'rejected'
        }
        const current = await permitted(candidate, signal)
        if (!current || current.app_id !== bot.app_id || current.app_secret !== bot.app_secret) return 'rejected'
        const result = await api.react(target.messageId, emoji, token, signal)
        if (result !== 'sent') return result
        try { await options.markReacted(identity, target) }
        catch { return 'unknown' }
        return 'sent'
      },
    }
    return {
      tools: createAgentImTools({ reaction }),
      authorize: async (candidate: RunIdentity, candidateSignal: AbortSignal) => Boolean(await permitted(candidate, candidateSignal)),
    }
  }
}
