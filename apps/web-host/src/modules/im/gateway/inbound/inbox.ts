import { wechatEventId } from '@gugu/gateway'
import { createHash } from 'node:crypto'
import type { RedisCommandClient } from '../../../../workers/redis-stream-queue.js'

export const NODE_IM_INBOUND_STREAM = 'im:node:inbound'
export const NODE_IM_SEEN_TTL_SECONDS = 600
export const NODE_IM_ATTENTION_TTL_SECONDS = 1800
type ObjectValue = Record<string, unknown>
export interface NodeImBotBinding { platform: 'feishu' | 'qq' | 'wechat' | 'telegram'; botId: string; ownerId: string }
export class NodeImInboxError extends Error {
  constructor(readonly code: 'invalid_input' | 'unavailable' | 'invalid_reply') { super('Node IM 入站操作未完成'); this.name = 'NodeImInboxError' }
}
function invalid(): never { throw new NodeImInboxError('invalid_input') }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return invalid()
  return value.trim()
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** owner也进入scope，避免绑定迁移期间不同账号共享短期索引或去重记录。 */
export function nodeImAttentionKeys(binding: NodeImBotBinding, groupId: string): { stream: string; start: string } {
  const digest = hash([identifier(binding.ownerId), binding.platform, identifier(binding.botId), identifier(groupId)])
  return { stream: `im:node:attention:scope:v1:${digest}`, start: `im:node:attention:scope-start:v1:${digest}` }
}

// Redis Lua不自动回滚运行时错误，所有TYPE和Stream ID顺序检查必须先于第一次写入。
const enqueueScript = `
local function keytype(key)
  local reply = redis.call('TYPE', key)
  if type(reply) == 'table' then return reply.ok end
  return reply
end
local expected = {'string', 'stream', 'stream', 'string'}
for index,key in ipairs(KEYS) do
  local actual = keytype(key)
  if actual ~= 'none' and actual ~= expected[index] then
    return redis.error_reply('Node IM key type invalid')
  end
end
local function lastid(key)
  if keytype(key) == 'none' then return '0-0' end
  local info = redis.call('XINFO', 'STREAM', key)
  for index=1,#info,2 do
    if info[index] == 'last-generated-id' then return info[index+1] end
  end
  return nil
end
local function greaterpart(left,right)
  if #left ~= #right then return #left > #right end
  return left > right
end
local function greaterid(left,right)
  local lm,ls = string.match(left, '^(%d+)%-(%d+)$')
  local rm,rs = string.match(right, '^(%d+)%-(%d+)$')
  if not lm or not rm then return true end
  if lm ~= rm then return greaterpart(lm,rm) end
  return greaterpart(ls,rs)
end
if KEYS[3] then
  local main_id = lastid(KEYS[2])
  local scope_id = lastid(KEYS[3])
  if not main_id or not scope_id or greaterid(scope_id,main_id) then
    return redis.error_reply('Node IM stream order invalid')
  end
  local start = redis.call('GET',KEYS[4])
  if start and not string.match(start,'^%d+$') then
    return redis.error_reply('Node IM scope marker invalid')
  end
end
if redis.call('EXISTS',KEYS[1]) == 1 then return nil end
local entry_id = redis.call('XADD',KEYS[2],'MAXLEN','~',ARGV[1],'*','data',ARGV[2])
if KEYS[3] then
  local event_ms = string.match(entry_id,'^(%d+)-')
  redis.call('XADD',KEYS[3],entry_id,'data',ARGV[2])
  redis.call('SET',KEYS[4],event_ms,'EX',ARGV[4],'NX')
  local cutoff_ms = math.max(0,tonumber(event_ms)-tonumber(ARGV[4])*1000)
  redis.call('XTRIM',KEYS[3],'MINID','~',string.format('%.0f',cutoff_ms)..'-0')
  redis.call('EXPIRE',KEYS[3],ARGV[4])
  redis.call('EXPIRE',KEYS[4],ARGV[4])
end
redis.call('SET',KEYS[1],'1','EX',ARGV[3])
return entry_id
`

function normalize(binding: NodeImBotBinding, value: unknown): ObjectValue {
  if (!['feishu', 'qq', 'wechat', 'telegram'].includes(binding.platform)) return invalid()
  const ownerId = identifier(binding.ownerId), botId = identifier(binding.botId)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const payload = value as ObjectValue
  if (payload.platform !== binding.platform || payload.owner_user_id !== ownerId ||
    (payload.channel_id !== undefined && payload.channel_id !== botId) || (payload.bot_id !== undefined && payload.bot_id !== botId) ||
    (payload.channel_id === undefined && payload.bot_id === undefined)) return invalid()
  if (payload.chat_type !== 'group' && payload.chat_type !== 'c2c') return invalid()
  const sender = identifier(payload.platform_user_id)
  const chatId = payload.chat_type === 'group' ? identifier(payload.chat_id) : payload.chat_id === undefined || payload.chat_id === null || payload.chat_id === '' ? '' : identifier(payload.chat_id)
  const resume = payload._pending_ask_resume_id === undefined || payload._pending_ask_resume_id === null || payload._pending_ask_resume_id === '' ? '' : identifier(payload._pending_ask_resume_id)
  if (!resume) identifier(payload.message_id)
  return { ...payload, platform: binding.platform, owner_user_id: ownerId, channel_id: botId, bot_id: botId,
    platform_user_id: sender, ...(payload.chat_type === 'group' || chatId ? { chat_id: chatId } : {}) }
}

/** Node专属写入口；不操作Python im:inbound/seen键，也不创建消费者或接管旧Worker。 */
export function createNodeImInbox(redis: RedisCommandClient, options: { maxLength?: number; maxPayloadBytes?: number } = {}) {
  const maxLength = options.maxLength ?? 10000, maxPayloadBytes = options.maxPayloadBytes ?? 1024 * 1024
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 1000000 || !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1 || maxPayloadBytes > 4 * 1024 * 1024) return invalid()
  return {
    async enqueue(binding: NodeImBotBinding, value: unknown): Promise<string | null> {
      let payload = normalize(binding, value)
      let serialized: string
      try {
        serialized = JSON.stringify(payload)
        // 防止自定义toJSON替换已经验证的身份；只处理实际将被入队的JSON事实。
        payload = normalize(binding, JSON.parse(serialized))
        serialized = JSON.stringify(payload)
      } catch { return invalid() }
      if (Buffer.byteLength(serialized, 'utf8') > maxPayloadBytes) return invalid()
      const resume = typeof payload._pending_ask_resume_id === 'string' ? payload._pending_ask_resume_id.trim() : ''
      const identity = [binding.ownerId.trim(), binding.platform, binding.botId.trim(), payload.chat_type, payload.chat_id ?? '', payload.platform_user_id,
        resume ? 'resume' : 'message', resume || wechatEventId(payload) || String(payload.message_id).trim()]
      const seen = `im:node:seen:${hash(identity)}`
      const keys = [seen, NODE_IM_INBOUND_STREAM]
      if (payload.chat_type === 'group') {
        const attention = nodeImAttentionKeys(binding, String(payload.chat_id))
        keys.push(attention.stream, attention.start)
      }
      let result: unknown
      try { result = await redis.sendCommand(['EVAL', enqueueScript, String(keys.length), ...keys, String(maxLength), serialized,
        String(NODE_IM_SEEN_TTL_SECONDS), String(NODE_IM_ATTENTION_TTL_SECONDS)]) }
      catch { throw new NodeImInboxError('unavailable') }
      if (result === null || result === undefined) return null
      if (typeof result !== 'string' || !/^\d+-\d+$/.test(result)) throw new NodeImInboxError('invalid_reply')
      return result
    },
  }
}
