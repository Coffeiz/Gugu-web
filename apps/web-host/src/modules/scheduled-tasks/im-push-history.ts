import { agentOwnerSessionKey, createSqlConversationHistoryTrimmer, createSqlImPushWriter } from '@gugu/core/agent-sessions'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { ScheduledImRecipient, ScheduledTaskDeliveryPlan } from './fixed-delivery-target.js'

const bindIfCurrent = `
local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[1] then return 0 end
if not current and ARGV[1] ~= '' then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', 43200)
return 1
`

export function createScheduledImPushHistory(core: SqlDataRuntime, redis: {
  get(key: string): Promise<string | null>
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}, removeUnreferenced: (ownerId: string, storageKey: string) => Promise<boolean>) {
  const write = createSqlImPushWriter(core.db, core.backend)
  const trim = createSqlConversationHistoryTrimmer(core.db, core.backend, removeUnreferenced)
  return async (plan: ScheduledTaskDeliveryPlan, platform: 'qq' | 'feishu' | 'wechat' | 'telegram', target: ScheduledImRecipient) => {
    const group = target.chat_type === 'group'
    const recipient = group ? target.chat_id : target.puid
    if (!recipient) return
    const botId = String(target.channel_id)
    const key = group ? `imsession:${platform}:${botId}:${recipient}`
      : agentOwnerSessionKey(plan.ownerId, { platform, platformUserId: recipient, botId, role: 'owner', chatType: 'c2c' })
    if (!key) return
    const raw = await redis.get(key).catch(() => undefined)
    const bound = raw && /^\d+$/u.test(raw) ? Number(raw) : 0
    const sessionId = await write({
      ownerId: plan.ownerId, peer: { platform, botId, chatType: target.chat_type, recipient },
      boundSessionId: Number.isSafeInteger(bound) && bound > 0 && bound <= 2_147_483_647 ? bound : null,
      title: plan.title, text: plan.text, artifacts: plan.artifacts,
    })
    // 只有事务已提交、且路由未被新会话或主动绑定替换时才刷新 Redis。
    try {
      if (raw !== undefined) await redis.eval(bindIfCurrent, 1, key, raw ?? '', String(sessionId))
    } finally {
      await trim(plan.ownerId, sessionId)
    }
  }
}
