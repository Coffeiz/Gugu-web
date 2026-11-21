import { proactiveImText } from '../../im/gateway/delivery/proactive.js'
import type { Pool } from 'pg'
import type { ProviderTransport } from '@gugu/core/providers'
import { createWechatBotApi, wechatAttachmentLimit, wechatOrigin } from '@gugu/core/im/wechat-bot-api'
import { bindScheduledImRecipient, fixedDeliveryTarget, type PreparedScheduledImDelivery, type ScheduledTaskDeliveryPlan } from './targets.js'
import type { createWebScheduledAttachmentResources } from './files.js'

const failed = '发送失败（请检查该平台连接）'
const noTarget = '无可触达地址（先给该 bot 发条消息）'
type Bot = { id: number; app_id: string; app_secret: string }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function officialEndpoint(base: string): boolean {
  const url = new URL(base || wechatOrigin)
  return url.origin === wechatOrigin && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash
}

/** 微信只走入站维护的 owner 私聊路由，发送前按同一 Bot/收件人刷新会话凭据。 */
export function createScheduledTaskWechatDelivery(pool: Pick<Pool, 'query'>, options: {
  enabled(): boolean
  readReach(ownerId: string): Promise<unknown>
  readTarget?(ownerId: string, recipient: string): Promise<unknown>
  decrypt(value: string): Promise<string> | string
  generateId(): string
  randomUin(): number
  transport: ProviderTransport
  readAttachment?: ReturnType<typeof createWebScheduledAttachmentResources>['read']
}) {
  const api = createWechatBotApi(options.transport, options)
  async function readBot(ownerId: string, botId?: number): Promise<Bot | undefined> {
    return (await pool.query<Bot>(`SELECT id,app_id,app_secret FROM user_bots
      WHERE user_id=$1 AND platform='wechat' AND enabled=TRUE
      ${botId === undefined ? 'ORDER BY id LIMIT 1' : 'AND id=$2'}`,
    botId === undefined ? [ownerId] : [ownerId, botId])).rows[0]
  }

  async function privateReach(ownerId: string, botId: number, recipient?: string) {
    try {
      const exact = recipient ? await options.readTarget?.(ownerId, recipient) : null
      const value = record(exact ?? await options.readReach(ownerId))
      if (!value || value.platform !== 'wechat' || String(value.channel_id) !== String(botId)) return null
      if (value.chat_type === 'group' || value.chat_id) return null
      if (typeof value.puid !== 'string' || !value.puid.trim() || typeof value.context_token !== 'string' || !value.context_token.trim()) return null
      if (recipient && value.puid !== recipient) return null
      return { recipient: value.puid, contextToken: value.context_token }
    } catch {
      return null
    }
  }

  return async (plan: ScheduledTaskDeliveryPlan): Promise<PreparedScheduledImDelivery> => {
    const fixed = fixedDeliveryTarget(plan, 'wechat')
    if (fixed === null || fixed?.group) return async () => noTarget
    const bot = await readBot(plan.ownerId, fixed?.botId)
    if (!bot) return async () => noTarget
    const target = await privateReach(plan.ownerId, bot.id, fixed?.recipient)
    if (!target) return async () => noTarget

    const currentContext = async () => {
      if (!options.enabled()) return null
      const current = await readBot(plan.ownerId, bot.id)
      if (!current || current.app_id !== bot.app_id || current.app_secret !== bot.app_secret || !officialEndpoint(current.app_id)) return null
      const reach = await privateReach(plan.ownerId, bot.id, fixed?.recipient)
      return reach?.recipient === target.recipient && options.enabled() ? reach.contextToken : null
    }
    const send = async () => {
      try {
        const context = await currentContext()
        if (!context) return failed
        const token = await options.decrypt(bot.app_secret)
        const sent = await api.sendText(target.recipient, context, token, proactiveImText(plan), AbortSignal.timeout(15_000))
        return sent ? '已发送' : failed
      } catch {
        // 发送可能已到达服务端，连接异常也不在此自动重试。
        return failed
      }
    }
    const prepared = bindScheduledImRecipient(send, bot.id, false, target.recipient)
    const readAttachment = options.readAttachment
    if (readAttachment) prepared.sendAttachment = async (artifact, assertLease) => {
      const signal = AbortSignal.timeout(120_000)
      async function authorize() {
        await assertLease?.()
        const context = await currentContext()
        if (!context) throw new Error('微信投递授权已失效')
        signal.throwIfAborted()
        return context
      }
      await authorize()
      const file = await readAttachment(plan.ownerId, artifact, () => wechatAttachmentLimit, signal)
      if (!file) return false
      return api.sendAttachment(target.recipient, await options.decrypt(bot.app_secret), file, signal, authorize)
    }
    return prepared
  }
}
