import { proactiveImText } from '../../im/gateway/delivery/proactive.js'
import type { Pool } from 'pg'
import { createFeishuBotApi, feishuAttachmentLimit } from '@gugu/core/im/feishu-bot-api'
import type { ProviderTransport } from '@gugu/core/providers'
import { bindScheduledImRecipient, fixedDeliveryTarget, type PreparedScheduledImDelivery, type ScheduledTaskDeliveryPlan } from './targets.js'
import { InvalidScheduledTaskDeliveryTarget } from '@gugu/scheduler/tasks'
import { readEnabledFeishuBot } from '../../im/routes.js'
import type { createWebScheduledAttachmentResources } from './files.js'

type Bot = NonNullable<Awaited<ReturnType<typeof readEnabledFeishuBot>>>
const noTarget = '无可触达地址（先给该 bot 发条消息）'
const failed = '发送失败（请检查该平台连接）'

function invalid(message: string): never {
  throw new InvalidScheduledTaskDeliveryTarget(message)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 在任何渠道发生副作用之前验证飞书目标。凭据只在发往固定飞书端点时解密。 */
export function createScheduledTaskFeishuDelivery(pool: Pick<Pool, 'query'>, options: {
  decrypt(value: string): Promise<string> | string
  transport: ProviderTransport
  enabled(): boolean
  readReach?(ownerId: string): Promise<unknown>
  readAttachment?: ReturnType<typeof createWebScheduledAttachmentResources>['read']
}) {
  const api = createFeishuBotApi(options.transport)
  async function privateRecipient(ownerId: string, bot: Bot, legacy: boolean): Promise<string | null> {
    if (bot.owner_platform_user_id) return bot.owner_platform_user_id
    if (!legacy || !options.readReach) return null
    try {
      const reach = record(await options.readReach(ownerId))
      if (reach.platform !== 'feishu' || String(reach.channel_id) !== String(bot.id)) return null
      if (reach.chat_type === 'group' || reach.chat_id) return null
      return typeof reach.puid === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(reach.puid) ? reach.puid : null
    } catch {
      return null
    }
  }
  async function ownsGroup(ownerId: string, chatId: string, botId: number): Promise<boolean> {
    const session = await pool.query(`SELECT id FROM conversation_sessions
      WHERE user_id=$1 AND source='feishu' AND chat_type='group' AND chat_id=$2 AND bot_id=$3 LIMIT 1`,
    [ownerId, chatId, String(botId)])
    return session.rows.length > 0
  }

  return async (plan: ScheduledTaskDeliveryPlan): Promise<PreparedScheduledImDelivery> => {
    const fixed = fixedDeliveryTarget(plan, 'feishu')
    if (fixed === null) return async () => noTarget
    const rawConfig = plan.channels.includes('feishu') ? plan.imDelivery?.feishu : undefined
    const config = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? record(rawConfig) : null
    if (config && config.mode !== 'private' && config.mode !== 'group') invalid('投递目标 mode 只能是 private 或 group')
    const group = fixed?.group ?? (config?.mode === 'group')
    const chatId = fixed?.recipient ?? (group && typeof config?.chat_id === 'string' ? config.chat_id.trim() : '')
    if (group && !chatId) invalid('群投递需要 chat_id')
    const bot = await readEnabledFeishuBot(pool, plan.ownerId, fixed?.botId)
    if (group) {
      if (!bot) {
        if (fixed) return async () => noTarget
        invalid('feishu Bot 未连接或已停用')
      }
      if (!await ownsGroup(plan.ownerId, chatId, bot.id)) {
        if (fixed) return async () => noTarget
        invalid('找不到该群会话，请先让咕咕在群里收到一条消息')
      }
    } else if (config?.mode === 'private' && !bot?.owner_platform_user_id) {
      invalid('feishu 尚无可用私聊目标，请先与 Bot 私聊')
    }
    if (!bot) return async () => noTarget
    const legacy = Boolean(plan.fixedTargets) || (plan.channels.includes('im') && !plan.channels.includes('feishu'))
    const recipient = group ? chatId : await privateRecipient(plan.ownerId, bot, legacy)
    if (!recipient || (fixed && recipient !== fixed.recipient)) return async () => noTarget
    const recipientType = group ? 'chat_id' : 'open_id'
    const currentBot = async () => {
      if (!options.enabled()) return null
      const current = await readEnabledFeishuBot(pool, plan.ownerId, bot.id)
      if (!current || current.app_id !== bot.app_id) return null
      if (group && !await ownsGroup(plan.ownerId, recipient, current.id)) return null
      if (!group && await privateRecipient(plan.ownerId, current, legacy) !== recipient) return null
      return options.enabled() ? current : null
    }
    const send = async () => {
      try {
        const current = await currentBot()
        if (!current) return failed
        const signal = AbortSignal.timeout(10_000)
        const token = await api.tenantToken(current.app_id, await options.decrypt(current.app_secret), signal)
        if (!options.enabled()) return failed
        await api.sendText(recipientType, recipient, proactiveImText(plan), token, signal)
        return '已发送'
      } catch {
        return failed
      }
    }
    const prepared = bindScheduledImRecipient(send, bot.id, group, recipient)
    const readAttachment = options.readAttachment
    if (readAttachment) prepared.sendAttachment = async (artifact, assertLease) => {
      const signal = AbortSignal.timeout(30_000)
      const current = await currentBot()
      if (!current) return false
      const file = await readAttachment(plan.ownerId, artifact, feishuAttachmentLimit, signal)
      if (!file) return false
      const recheck = async () => {
        await assertLease?.()
        if ((await currentBot())?.app_secret !== current.app_secret) throw new Error('飞书投递授权已失效')
        signal.throwIfAborted()
      }
      await recheck()
      const token = await api.tenantToken(current.app_id, await options.decrypt(current.app_secret), signal)
      await recheck()
      await api.sendAttachment(recipientType, recipient, file, token, signal, recheck)
      return true
    }
    return prepared
  }
}
