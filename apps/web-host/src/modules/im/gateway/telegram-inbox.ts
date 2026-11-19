import { createHash } from 'node:crypto'
import type { RedisCommandClient } from '../../../workers/redis-stream-queue.js'
import { NODE_IM_INBOUND_STREAM, NODE_IM_ATTENTION_TTL_SECONDS, nodeImAttentionKeys } from './inbox.js'
import { createImInboundEnvelope } from './inbound-envelope.js'

/** 独立 Node 命名空间；不读取、清理或 ACK Python 的入站消息。 */
export { NODE_IM_INBOUND_STREAM }
export const TELEGRAM_ENQUEUE_SCRIPT = `
local stream, dedup, cursor = KEYS[1], KEYS[2], KEYS[3]
local update_id, payload = ARGV[1], ARGV[2]
local expected = {'stream', 'string', 'string', 'stream', 'string'}
for index,key in ipairs(KEYS) do
  local kind = redis.call('TYPE',key)
  if type(kind) == 'table' then kind = kind.ok end
  if kind ~= 'none' and kind ~= expected[index] then return redis.error_reply('Telegram key type invalid') end
end
local function lastid(key)
  local kind = redis.call('TYPE',key)
  if type(kind) == 'table' then kind = kind.ok end
  if kind == 'none' then return '0-0' end
  local info = redis.call('XINFO','STREAM',key)
  for index=1,#info,2 do if info[index] == 'last-generated-id' then return info[index+1] end end
  return nil
end
local function greaterpart(left,right)
  if #left ~= #right then return #left > #right end
  return left > right
end
local function greaterid(left,right)
  local lm,ls = string.match(left,'^(%d+)%-(%d+)$')
  local rm,rs = string.match(right,'^(%d+)%-(%d+)$')
  if not lm or not rm then return true end
  if lm ~= rm then return greaterpart(lm,rm) end
  return greaterpart(ls,rs)
end
if KEYS[4] then
  local main_id,scope_id = lastid(stream),lastid(KEYS[4])
  if not main_id or not scope_id or greaterid(scope_id,main_id) then return redis.error_reply('Telegram stream order invalid') end
  local start = redis.call('GET',KEYS[5])
  if start and not string.match(start,'^%d+$') then return redis.error_reply('Telegram scope start invalid') end
end
if redis.call('EXISTS', dedup) == 0 then
  if payload ~= '' then
    local entry_id = redis.call('XADD', stream, 'MAXLEN', '~', 10000, '*', 'data', payload)
    if KEYS[4] then
      local event_ms = string.match(entry_id,'^(%d+)-')
      redis.call('XADD',KEYS[4],entry_id,'data',payload)
      redis.call('SET',KEYS[5],event_ms,'EX',ARGV[3],'NX')
      local cutoff_ms = math.max(0,tonumber(event_ms)-tonumber(ARGV[3])*1000)
      redis.call('XTRIM',KEYS[4],'MINID','~',string.format('%.0f',cutoff_ms)..'-0')
      redis.call('EXPIRE',KEYS[4],ARGV[3])
      redis.call('EXPIRE',KEYS[5],ARGV[3])
    end
  end
  redis.call('SET', dedup, '1', 'EX', 172800)
end
redis.call('SET', cursor, update_id, 'EX', 518400)
return 1
`

/** 对照 Python Telegram 的原子入队/48 小时去重/6 天游标契约。 */
export function createTelegramInbox(redis: RedisCommandClient, botId: string, ownerId: string, secretKey: string) {
  if (!/^[1-9]\d*$/.test(botId) || !ownerId) throw new TypeError('Telegram 入站身份无效')
  const scope = createHash('sha256').update(JSON.stringify([ownerId, botId])).digest('hex')
  const namespace = `im:node:telegram:v1:${scope}`
  const cursorKey = `${namespace}:last-enqueued-update`
  const binding = { platform: 'telegram' as const, botId, ownerId }
  const envelope = createImInboundEnvelope(secretKey)
  return {
    async cursor(): Promise<number | null> {
      let value: unknown
      try { value = await redis.sendCommand(['GET', cursorKey]) }
      catch { throw new Error('Telegram 游标读取失败') }
      if (value === null) return null
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error('Telegram 游标格式无效')
      return Number(value)
    },
    async commit(updateId: number, payload: Record<string, unknown> | null): Promise<void> {
      if (!Number.isSafeInteger(updateId) || updateId < 0) throw new TypeError('Telegram 事件 ID 无效')
      // 平台解析器输出仍须绑定本连接；禁止把别的 Bot/owner 的消息写入该游标。
      if (payload && (payload.platform !== 'telegram' || payload.bot_id !== botId
        || payload.channel_id !== botId || payload.owner_user_id !== ownerId))
        throw new TypeError('Telegram 入站作用域不匹配')
      let data: string
      let groupId: string | null = null
      try {
        data = payload ? JSON.stringify(payload) : ''
        if (Buffer.byteLength(data) > 1_048_576) throw new Error()
        // 校验实际序列化结果，防止toJSON改变已验证的路由身份。
        if (payload) {
          const value: unknown = JSON.parse(data)
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
          const saved = value as Record<string, unknown>
          if (saved.platform !== 'telegram' || saved.bot_id !== botId || saved.channel_id !== botId || saved.owner_user_id !== ownerId) throw new Error()
          // commit仅由完成正式preflight的poller调用；Worker不再用新的prompt解释旧文本。
          const sealed = envelope.sealAdmitted(binding, saved)
          groupId = sealed.chat_type === 'group' ? String(sealed.chat_id) : null
          data = JSON.stringify(sealed)
          if (Buffer.byteLength(data) > 1_048_576) throw new Error()
        }
      }
      catch { throw new TypeError('Telegram 消息格式无效') }
      try {
        const keys = [NODE_IM_INBOUND_STREAM, `${namespace}:update:${updateId}`, cursorKey]
        if (groupId) { const attention = nodeImAttentionKeys(binding, groupId); keys.push(attention.stream, attention.start) }
        const result = await redis.sendCommand(['EVAL', TELEGRAM_ENQUEUE_SCRIPT, String(keys.length), ...keys,
          String(updateId), data, String(NODE_IM_ATTENTION_TTL_SECONDS)])
        if (result !== 1 && result !== '1') throw new Error()
      } catch { throw new Error('Telegram 入站持久化失败') }
    },
  }
}
