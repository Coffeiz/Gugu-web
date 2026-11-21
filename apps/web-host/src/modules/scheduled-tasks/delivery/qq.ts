import { proactiveImText } from '../../im/gateway/delivery/proactive.js'
import type { Pool } from 'pg'
import type { ProviderTransport } from '@gugu/core/providers'
import { createQqBotApi, qqAttachmentLimit } from '@gugu/core/im/qq-bot-api'
import { bindScheduledImRecipient, fixedDeliveryTarget, type PreparedScheduledImDelivery, type ScheduledTaskDeliveryPlan } from './targets.js'
import { InvalidScheduledTaskDeliveryTarget } from '@gugu/core/scheduled-task-test-notify'
import type { createWebScheduledAttachmentResources } from './files.js'

const failed = '发送失败（请检查该平台连接）'
const noTarget = '无可触达地址（先给该 bot 发条消息）'
type Bot = { id: number; app_id: string; app_secret: string; owner_platform_user_id: string | null; sandbox: boolean }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function recipientId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

/** 只向 owner 绑定的 QQ 私聊或该 Bot 已见过的 owner 群发送主动消息。 */
export function createScheduledTaskQqDelivery(pool: Pick<Pool, 'query'>, options: {
  enabled(): boolean
  decrypt(value: string): Promise<string> | string
  readReach?(ownerId: string): Promise<unknown>
  transport: ProviderTransport
  readAttachment?: ReturnType<typeof createWebScheduledAttachmentResources>['read']
}) {
  const api = createQqBotApi(options.transport)
  async function privateRecipient(ownerId: string, bot: Bot, legacy: boolean): Promise<string | null> {
    if (recipientId(bot.owner_platform_user_id)) return bot.owner_platform_user_id
    if (!legacy || !options.readReach) return null
    try {
      const value = record(await options.readReach(ownerId))
      if (!value || value.platform !== 'qq' || String(value.channel_id) !== String(bot.id) || value.chat_type === 'group' || value.chat_id) return null
      return recipientId(value.puid) ? value.puid : null
    } catch {
      return null
    }
  }

  async function readBot(ownerId: string, botId?: number): Promise<Bot | undefined> {
    return (await pool.query<Bot>(`SELECT id,app_id,app_secret,owner_platform_user_id,sandbox FROM user_bots
      WHERE user_id=$1 AND platform='qq' AND enabled=TRUE
      ${botId === undefined ? 'ORDER BY id LIMIT 1' : 'AND id=$2'}`,
    botId === undefined ? [ownerId] : [ownerId, botId])).rows[0]
  }
  async function ownsGroup(ownerId: string, chatId: string, botId: number): Promise<boolean> {
    const session = await pool.query(`SELECT id FROM conversation_sessions
      WHERE user_id=$1 AND source='qq' AND chat_type='group' AND chat_id=$2 AND bot_id=$3 LIMIT 1`,
    [ownerId, chatId, String(botId)])
    return session.rows.length > 0
  }

  return async (plan: ScheduledTaskDeliveryPlan): Promise<PreparedScheduledImDelivery> => {
    const fixed = fixedDeliveryTarget(plan, 'qq')
    if (fixed === null) return async () => noTarget
    const config = plan.channels.includes('qq') ? record(plan.imDelivery?.qq) : null
    if (config && config.mode !== 'private' && config.mode !== 'group')
      throw new InvalidScheduledTaskDeliveryTarget('投递目标 mode 只能是 private 或 group')
    const group = fixed?.group ?? (config?.mode === 'group')
    const chatId = fixed?.recipient ?? (group && typeof config?.chat_id === 'string' ? config.chat_id.trim() : '')
    if (fixed && !recipientId(fixed.recipient)) return async () => noTarget
    if (group && !recipientId(chatId)) throw new InvalidScheduledTaskDeliveryTarget('群投递需要有效的 chat_id')
    const bot = await readBot(plan.ownerId, fixed?.botId)
    if (group) {
      if (!bot) {
        if (fixed) return async () => noTarget
        throw new InvalidScheduledTaskDeliveryTarget('qq Bot 未连接或已停用')
      }
      if (!await ownsGroup(plan.ownerId, chatId, bot.id)) {
        if (fixed) return async () => noTarget
        throw new InvalidScheduledTaskDeliveryTarget('找不到该群会话，请先让咕咕在群里收到一条消息')
      }
    }
    if (!bot) return async () => noTarget
    const legacy = Boolean(plan.fixedTargets) || (plan.channels.includes('im') && !plan.channels.includes('qq'))
    const recipient = group ? chatId : await privateRecipient(plan.ownerId, bot, legacy)
    if (!recipient || (fixed && recipient !== fixed.recipient)) return async () => noTarget
    const target = { recipient, group, sandbox: bot.sandbox }
    const currentBot = async () => {
      if (!options.enabled()) return null
      const current = await readBot(plan.ownerId, bot.id)
      if (!current || current.app_id !== bot.app_id || current.sandbox !== bot.sandbox) return null
      if (group && !await ownsGroup(plan.ownerId, recipient, current.id)) return null
      if (!group && await privateRecipient(plan.ownerId, current, legacy) !== recipient) return null
      return options.enabled() ? current : null
    }
    const send = async () => {
      try {
        const current = await currentBot()
        if (!current) return failed
        const signal = AbortSignal.timeout(15_000)
        const token = await api.token(current.app_id, await options.decrypt(current.app_secret), signal)
        if (!token || !options.enabled()) return failed
        return await api.sendText(target, proactiveImText(plan), token, signal) ? '已发送' : failed
      } catch {
        return failed
      }
    }
    const prepared = bindScheduledImRecipient(send, bot.id, group, recipient)
    const readAttachment = options.readAttachment
    if (readAttachment) prepared.sendAttachment = async (artifact, assertLease) => {
      const signal = AbortSignal.timeout(300_000)
      const current = await currentBot()
      if (!current) return false
      const file = await readAttachment(plan.ownerId, artifact, () => qqAttachmentLimit, signal)
      if (!file) return false
      const recheck = async () => {
        await assertLease?.()
        if ((await currentBot())?.app_secret !== current.app_secret) throw new Error('QQ 投递授权已失效')
        signal.throwIfAborted()
      }
      await recheck()
      const token = await api.token(current.app_id, await options.decrypt(current.app_secret), signal)
      return token !== null && await api.sendAttachment(target, file, token, signal, recheck)
    }
    return prepared
  }
}
