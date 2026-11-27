import { createHash } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import { stableJson } from '../../agent/context/history/canonical-history.js'

export const desktopScheduleImPlatforms = ['feishu', 'qq', 'telegram', 'wechat'] as const
const identifier = z.string().min(1).max(256).regex(/^[A-Za-z0-9_@.:-]+$/u).refine(value => value !== '.' && value !== '..')
const identityFields = { botId: identifier, boundUserId: identifier, recipient: identifier }
export const desktopSchedulePrivateBinding = z.object({
  ...identityFields, platform: z.enum(desktopScheduleImPlatforms), chatType: z.literal('c2c'),
}).strict().refine(target => target.recipient === target.boundUserId)

export const desktopScheduleImTarget = z.discriminatedUnion('chatType', [
  z.object({ platform: z.enum(desktopScheduleImPlatforms), chatType: z.literal('c2c') }).strict(),
  z.object({ ...identityFields, platform: z.enum(['feishu', 'qq', 'telegram']), chatType: z.literal('group') }).strict(),
])
export type DesktopScheduleImPlatform = typeof desktopScheduleImPlatforms[number]
export type DesktopScheduleImTarget = z.infer<typeof desktopScheduleImTarget>

export function desktopScheduleImConnection(target: Extract<DesktopScheduleImTarget, { chatType: 'group' }> | z.infer<typeof desktopSchedulePrivateBinding>): string {
  const fields = target.chatType === 'group'
    ? [`${target.platform}-group`, target.botId, target.recipient, target.boundUserId]
    : [target.botId, target.boundUserId]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

export function readDesktopScheduleImTargets(deliveryTargets: unknown, channels: readonly string[]): DesktopScheduleImTarget[] {
  const imChannels = channels.filter(channel => channel !== 'web')
  if (!imChannels.length) return []
  if (new Set(imChannels).size !== imChannels.length || !deliveryTargets || typeof deliveryTargets !== 'object')
    throw new Error('桌面定时任务投递目标无效')
  const targets = imChannels.map(platform => {
    const target = desktopScheduleImTarget.safeParse((deliveryTargets as Record<string, unknown>)[platform])
    if (!target.success || target.data.platform !== platform)
      throw new Error('桌面定时任务投递目标无效')
    return target.data
  })
  if (targets.filter(target => target.chatType === 'group').length > 1)
    throw new Error('桌面定时任务只能投递到一个群')
  return targets
}

export function desktopScheduleImDeliveryTargets(targets: readonly DesktopScheduleImTarget[]) {
  return Object.fromEntries(targets.map(target => [target.platform, target]))
}

export async function ownsDesktopScheduleImTarget<DB>(db: Kysely<DB>, ownerId: string, target: DesktopScheduleImTarget) {
  // 私聊由宿主实时复查绑定用户；群目标另需匹配已登记的本地群会话。
  if (target.chatType === 'c2c') return true
  const owner = ownerId.replaceAll('-', '')
  const connection = desktopScheduleImConnection(target)
  const { rows } = await sql`SELECT 1 FROM desktop_im_sessions im
    JOIN conversation_sessions s ON s.id=im.session_id AND s.user_id=im.owner_id
    WHERE im.owner_id=${owner} AND im.platform=${target.platform} AND im.connection_id=${connection}
      AND s.chat_type='group'`.execute(db)
  return rows.length === 1
}

export function desktopScheduleImReminderVersion(task: { name: string; payload: string; channels: readonly string[] }, targets: readonly DesktopScheduleImTarget[]) {
  return createHash('sha256').update(stableJson([task.name, task.payload, task.channels, targets])).digest('hex')
}
