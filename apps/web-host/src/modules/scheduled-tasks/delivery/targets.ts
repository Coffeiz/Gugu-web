import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { UserFromRequest } from '../../../app.js'
import { normalizeOwnerId } from '../../../shared/owner-context.js'
import type { ScheduledTaskTestNotificationPlan } from '@gugu/scheduler/tasks'
import { parseScheduledTaskDeliveryTarget } from '@gugu/core/tasks/execution-read'
import type { EmailAttachmentReferences } from '@gugu/core/email/smtp-test'
import type { AssertScheduledTaskLease } from '@gugu/scheduler'

type GroupRow = { chat_id: string; title: string | null }

const platforms = new Set(['qq', 'feishu', 'telegram'])

/** 仅返回当前用户可选群的标识与显示名称。 */
export function createScheduledTaskDeliveryTargets(pool: Pick<Pool, 'query'>) {
  async function groups(owner: string, platform: string, botId: string | null) {
    const rows = await pool.query<GroupRow>(
      `SELECT chat_id,title FROM conversation_sessions
       WHERE user_id=$1 AND source=$2 AND chat_type='group' AND chat_id IS NOT NULL
         AND ($3::text IS NULL OR bot_id=$3) ORDER BY id DESC`, [owner, platform, botId],
    )
    const unique = new Map<string, string>()
    for (const row of rows.rows) if (!unique.has(String(row.chat_id))) unique.set(String(row.chat_id), row.title || '未命名群会话')
    return [...unique].map(([chat_id, title]) => ({ chat_id, title }))
  }
  return {
    async qq(rawOwner: string) {
      return { groups: await groups(normalizeOwnerId(rawOwner), 'qq', null) }
    },
    async platform(rawOwner: string, platform: string) {
      if (!platforms.has(platform)) return null
      const owner = normalizeOwnerId(rawOwner)
      const result = await pool.query<{ id: number; owner_platform_user_id: string | null }>(
        `SELECT id,owner_platform_user_id FROM user_bots
         WHERE user_id=$1 AND platform=$2 AND enabled=TRUE ORDER BY id ASC LIMIT 1`, [owner, platform],
      )
      const bot = result.rows[0]
      if (!bot) return { private_available: false, groups: [] }
      return { private_available: platform === 'qq' || Boolean(bot.owner_platform_user_id), groups: await groups(owner, platform, String(bot.id)) }
    },
  }
}

export function registerScheduledTaskDeliveryTargets(app: FastifyInstance, userFromRequest: UserFromRequest, targets: ReturnType<typeof createScheduledTaskDeliveryTargets>) {
  app.get('/api/v1/scheduled-tasks/qq-targets', request => targets.qq(userFromRequest(request).requestContext.data.ownerId))
  app.get<{ Params: { platform: string } }>('/api/v1/scheduled-tasks/delivery-targets/:platform', async (request, reply) => {
    const result = await targets.platform(userFromRequest(request).requestContext.data.ownerId, request.params.platform)
    return result ?? reply.code(404).send({ detail: '不支持该 IM 平台' })
  })
}

export type ScheduledTaskDeliveryPlan = ScheduledTaskTestNotificationPlan & {
  plainText?: boolean
  fixedTargets?: Readonly<Record<string, unknown>>
  artifacts?: readonly unknown[]
  emailAttachments?: EmailAttachmentReferences
  emailRecipient?: string | null
}

export type ScheduledImRecipient = { channel_id: number; chat_type: 'group' | 'c2c'; chat_id?: string; puid?: string }

export type PreparedScheduledImDelivery = (() => Promise<string>) & {
  recipient?: ScheduledImRecipient
  sendAttachment?(artifact: unknown, assertLease?: AssertScheduledTaskLease): Promise<boolean>
}

/** 快照仅携带 Bot 和收件人标识。发送时的凭据及权限仍由渠道适配器复核。 */
export function bindScheduledImRecipient(
  send: () => Promise<string>, botId: number, group: boolean, recipient: string,
): PreparedScheduledImDelivery {
  return Object.assign(send, {
    recipient: group
      ? { channel_id: botId, chat_type: 'group' as const, chat_id: recipient }
      : { channel_id: botId, chat_type: 'c2c' as const, puid: recipient },
  })
}

export function fixedDeliveryTarget(plan: Pick<ScheduledTaskDeliveryPlan, 'fixedTargets'>, platform: string) {
  return parseScheduledTaskDeliveryTarget(plan.fixedTargets, platform)
}
