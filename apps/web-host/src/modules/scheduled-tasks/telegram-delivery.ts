import type { Pool } from 'pg'
import { telegramDocumentLimit } from '@gugu/core/im/telegram-connect'
import { bindScheduledImRecipient, fixedDeliveryTarget, type PreparedScheduledImDelivery, type ScheduledTaskDeliveryPlan } from './fixed-delivery-target.js'
import { InvalidScheduledTaskDeliveryTarget } from '@gugu/core/scheduled-task-test-notify'
import type { createWebScheduledAttachmentResources } from './send-file.js'

const failed = '发送失败（请检查该平台连接）'
const noTarget = '无可触达地址（先给该 bot 发条消息）'
type Bot = { id: number; app_id: string; app_secret: string; owner_platform_user_id: string | null }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const telegramId = (value: unknown): value is string => typeof value === 'string' && /^-?\d{1,20}$/.test(value)

/** Telegram 试投递始终按认证 owner 和当前启用 Bot 复核；官方 Bot API 的 Token 路径由 Core 固定。 */
export function createScheduledTaskTelegramDelivery(pool: Pick<Pool, 'query'>, options: {
  enabled(): boolean
  decrypt(value: string): Promise<string> | string
  readReach?(ownerId: string): Promise<unknown>
  sendMessage(token: string, chatId: string, text: string): Promise<boolean>
  sendAttachment?(token: string, chatId: string, file: { bytes: Uint8Array; filename: string; mime: string }): Promise<boolean>
  readAttachment?: ReturnType<typeof createWebScheduledAttachmentResources>['read']
}) {
  async function readBot(ownerId: string, botId?: number): Promise<Bot | undefined> {
    return (await pool.query<Bot>(`SELECT id,app_id,app_secret,owner_platform_user_id FROM user_bots
      WHERE user_id=$1 AND platform='telegram' AND enabled=TRUE
      ${botId === undefined ? 'ORDER BY id LIMIT 1' : 'AND id=$2'}`,
    botId === undefined ? [ownerId] : [ownerId, botId])).rows[0]
  }
  async function ownsGroup(ownerId: string, chatId: string, botId: number): Promise<boolean> {
    const session = await pool.query(`SELECT id FROM conversation_sessions
      WHERE user_id=$1 AND source='telegram' AND chat_type='group' AND chat_id=$2 AND bot_id=$3 LIMIT 1`,
    [ownerId, chatId, String(botId)])
    return session.rows.length > 0
  }
  async function privateRecipient(ownerId: string, bot: Bot, legacy: boolean): Promise<string | null> {
    if (telegramId(bot.owner_platform_user_id)) return bot.owner_platform_user_id
    if (!legacy || !options.readReach) return null
    try {
      const raw = await options.readReach(ownerId)
      const reach = object(raw) ? raw : null
      if (!reach || reach.platform !== 'telegram' || String(reach.channel_id) !== String(bot.id)
        || reach.chat_type === 'group' || reach.chat_id) return null
      return telegramId(reach.puid) ? reach.puid : null
    } catch { return null }
  }

  return async (plan: ScheduledTaskDeliveryPlan): Promise<PreparedScheduledImDelivery> => {
    const fixed = fixedDeliveryTarget(plan, 'telegram')
    if (fixed === null) return async () => noTarget
    const config = plan.channels.includes('telegram') && object(plan.imDelivery?.telegram) ? plan.imDelivery.telegram : null
    if (config && config.mode !== 'private' && config.mode !== 'group')
      throw new InvalidScheduledTaskDeliveryTarget('投递目标 mode 只能是 private 或 group')
    const group = fixed?.group ?? config?.mode === 'group'
    const chatId = fixed?.recipient ?? (group && typeof config?.chat_id === 'string' ? config.chat_id.trim() : '')
    if (group && !telegramId(chatId)) throw new InvalidScheduledTaskDeliveryTarget('群投递需要有效的 chat_id')
    const bot = await readBot(plan.ownerId, fixed?.botId)
    if (!bot) {
      if (fixed) return async () => noTarget
      throw new InvalidScheduledTaskDeliveryTarget('telegram Bot 未连接或已停用')
    }
    if (group && !await ownsGroup(plan.ownerId, chatId, bot.id)) {
      if (fixed) return async () => noTarget
      throw new InvalidScheduledTaskDeliveryTarget('找不到该群会话，请先让咕咕在群里收到一条消息')
    }
    const legacy = Boolean(plan.fixedTargets) || (plan.channels.includes('im') && !plan.channels.includes('telegram'))
    const recipient = group ? chatId : fixed?.recipient ?? await privateRecipient(plan.ownerId, bot, legacy)
    if (!telegramId(recipient) || (fixed && recipient !== fixed.recipient)) return async () => noTarget
    const target = { recipient, group, botId: bot.id }
    const currentBot = async () => {
      if (!options.enabled()) return null
      const current = await readBot(plan.ownerId, target.botId)
      if (!current || current.app_id !== bot.app_id) return null
      if (group && !await ownsGroup(plan.ownerId, recipient, current.id)) return null
      if (!group && await privateRecipient(plan.ownerId, current, legacy) !== recipient) return null
      return options.enabled() ? current : null
    }
    const send = async () => {
      try {
        const current = await currentBot()
        if (!current) return failed
        const token = await options.decrypt(current.app_secret)
        return await options.sendMessage(token, target.recipient, `⏰ ${plan.title}\n\n${plan.text}`) ? '已发送' : failed
      } catch { return failed }
    }
    const prepared = bindScheduledImRecipient(send, bot.id, group, recipient)
    const sendAttachment = options.sendAttachment
    const readAttachment = options.readAttachment
    if (sendAttachment && readAttachment) prepared.sendAttachment = async (artifact, assertLease) => {
      const signal = AbortSignal.timeout(120_000)
      const current = await currentBot()
      if (!current) return false
      const file = await readAttachment(plan.ownerId, artifact, () => telegramDocumentLimit, signal)
      if (!file) return false
      await assertLease?.()
      const latest = await currentBot()
      if (!latest || latest.app_secret !== current.app_secret) return false
      signal.throwIfAborted()
      const token = await options.decrypt(latest.app_secret)
      const authorized = await currentBot()
      if (!authorized || authorized.app_secret !== latest.app_secret) return false
      const mime = file.ext === 'jpg' || file.ext === 'jpeg' ? 'image/jpeg'
        : file.ext === 'png' ? 'image/png' : 'application/octet-stream'
      return sendAttachment(token, recipient, {
        bytes: file.bytes, filename: file.filename, mime,
      })
    }
    return prepared
  }
}
