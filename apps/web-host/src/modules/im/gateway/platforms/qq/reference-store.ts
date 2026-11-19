import { createHmac } from 'node:crypto'
import type { QqEmojiRef } from '@gugu/core/im/qq-message'
import type { RedisCommandClient } from '../../../../../workers/redis-stream-queue.js'
import { createImInboundEnvelope } from '../../inbound/envelope.js'
import type { ImAttachmentScope } from '../../inbound/attachments.js'

type Value = Record<string, unknown>
export const QQ_REFERENCE_TTL_SECONDS = 7 * 24 * 60 * 60
export const QQ_REFERENCE_MAX_ENTRIES = 50_000
export const QQ_FACE_PENDING_MS = 3000
const pendingLimit = 128
const rememberScript = `
local expected={'string','zset'}
for i,key in ipairs(KEYS) do
 local kind=redis.call('TYPE',key); if type(kind)=='table' then kind=kind.ok end
 if kind~='none' and kind~=expected[i] then return redis.error_reply('QQ reference type invalid') end
end
local expired=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',ARGV[4])
local extra=redis.call('ZCARD',KEYS[2])-#expired
local existing=redis.call('ZSCORE',KEYS[2],KEYS[1])
if not existing or tonumber(existing)<=tonumber(ARGV[4]) then extra=extra+1 end
extra=math.max(0,extra-tonumber(ARGV[3]))
local evicted={}
if extra>0 then evicted=redis.call('ZRANGE',KEYS[2],#expired,#expired+extra-1) end
for _,key in ipairs(evicted) do
 if string.sub(key,1,#ARGV[5])~=ARGV[5] then return redis.error_reply('QQ reference scope invalid') end
end
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[4])
for _,key in ipairs(evicted) do redis.call('DEL',key); redis.call('ZREM',KEYS[2],key) end
redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2])
redis.call('ZADD',KEYS[2],ARGV[6],KEYS[1])
redis.call('EXPIRE',KEYS[2],ARGV[2])
return 1
`
const queueScript = `
local expected={'list','string'}
for i,key in ipairs(KEYS) do
 local kind=redis.call('TYPE',key); if type(kind)=='table' then kind=kind.ok end
 if kind~='none' and kind~=expected[i] then return redis.error_reply('QQ face type invalid') end
end
if redis.call('EXISTS',KEYS[2])==1 then return 1 end
if redis.call('LLEN',KEYS[1])>=tonumber(ARGV[2]) then return redis.error_reply('QQ face queue full') end
redis.call('RPUSH',KEYS[1],ARGV[1]); redis.call('EXPIRE',KEYS[1],4)
redis.call('SET',KEYS[2],'1','EX',600)
return 1
`
const popScript = `
local expected={'list','string'}
for i,key in ipairs(KEYS) do
 local kind=redis.call('TYPE',key); if type(kind)=='table' then kind=kind.ok end
 if kind~='none' and kind~=expected[i] then return redis.error_reply('QQ face type invalid') end
end
local prior=redis.call('GET',KEYS[2]); if prior then return prior end
local picked='-'
for i=1,128 do
 local raw=redis.call('LPOP',KEYS[1]); if not raw then break end
 local ok,item=pcall(cjson.decode,raw)
 if not ok or type(item)~='table' or type(item.expires)~='number' or type(item.data)~='string' then return redis.error_reply('QQ face entry invalid') end
 if item.expires>tonumber(ARGV[1]) then picked=item.data; break end
end
redis.call('SET',KEYS[2],picked,'EX',600)
return picked
`
const invalid = () => new Error('QQ 引用或表情状态暂时不可用')
const object = (value: unknown): value is Value => !!value && typeof value === 'object' && !Array.isArray(value)

/** Node专属加密引用索引与FIFO；不读取旧Python JSONL，也不清理其他消费者状态。 */
export function createQqReferenceStore(options: { redis: RedisCommandClient; secretKey: string; now?(): number }) {
  if (!options.secretKey) throw invalid()
  const envelope = createImInboundEnvelope(options.secretKey), now = options.now ?? Date.now
  const hash = (value: unknown) => createHmac('sha256', options.secretKey).update('gugu-node-qq-reference-v1\0').update(JSON.stringify(value)).digest('hex')
  function normalized(scope: ImAttachmentScope): ImAttachmentScope {
    if (scope.platform !== 'qq' || !scope.ownerId || !/^[1-9]\d*$/u.test(scope.botId) || !scope.platformUserId ||
      (scope.chatType === 'c2c' ? scope.chatId !== null : scope.chatType !== 'group' || !scope.chatId)) throw invalid()
    return Object.freeze({ ...scope })
  }
  const binding = (scope: ImAttachmentScope) => ({ ownerId: scope.ownerId, botId: scope.botId, platform: 'qq' as const })
  function prefix(scope: ImAttachmentScope): string { return `im:node:qq:ref:v1:${hash([scope.ownerId, scope.botId])}:` }
  function refKey(scope: ImAttachmentScope, id: string): string {
    if (!id || id.length > 8192 || /[\x00-\x1f\x7f]/u.test(id)) throw invalid()
    return prefix(scope) + hash([scope.chatType, scope.chatId || scope.platformUserId, id])
  }
  function faceKey(scope: ImAttachmentScope): string {
    // Python群队列没有speaker；Node按原任务隔离发言人，防他人图片吃掉本人的待配对表情。
    return `im:node:qq:face:v1:${hash([scope.ownerId, scope.botId, scope.chatType, scope.chatId, scope.platformUserId])}`
  }
  function sealed(scope: ImAttachmentScope, eventId: string, fields: Value): Value {
    return envelope.seal(binding(scope), { platform: 'qq', owner_user_id: scope.ownerId, bot_id: scope.botId, channel_id: scope.botId,
      chat_type: scope.chatType, chat_id: scope.chatId, platform_user_id: scope.platformUserId, message_id: eventId, ...fields })
  }
  function opened(scope: ImAttachmentScope, raw: string): Value {
    const decoded: unknown = JSON.parse(raw)
    if (!object(decoded)) throw invalid()
    const value = envelope.open(binding(scope), decoded)
    if (value.chat_type !== scope.chatType || (scope.chatType === 'group' ? value.chat_id !== scope.chatId : value.platform_user_id !== scope.platformUserId)) throw invalid()
    return value
  }
  async function evalCommand(script: string, keys: string[], values: string[]): Promise<unknown> {
    return options.redis.sendCommand(['EVAL', script, String(keys.length), ...keys, ...values])
  }
  return {
    async remember(rawScope: ImAttachmentScope, index: string, entry: Value, signal: AbortSignal): Promise<void> {
      const scope = normalized(rawScope)
      try {
        signal.throwIfAborted()
        const data = JSON.stringify(sealed(scope, index, { reference_entry: entry })), time = now()
        if (!Number.isSafeInteger(time) || time < 0) throw invalid()
        const result = await evalCommand(rememberScript, [refKey(scope, index), `${prefix(scope)}entries`],
          [data, String(QQ_REFERENCE_TTL_SECONDS), String(QQ_REFERENCE_MAX_ENTRIES), String(time - QQ_REFERENCE_TTL_SECONDS * 1000), prefix(scope), String(time)])
        if (result !== 1 && result !== '1') throw invalid()
        signal.throwIfAborted()
      } catch { signal.throwIfAborted(); throw invalid() }
    },
    async read(rawScope: ImAttachmentScope, index: string, signal: AbortSignal): Promise<Value | null> {
      const scope = normalized(rawScope)
      try {
        signal.throwIfAborted()
        const raw = await options.redis.sendCommand(['GET', refKey(scope, index)])
        if (raw === null) return null
        if (typeof raw !== 'string') throw invalid()
        const value = opened(scope, raw)
        if (value.message_id !== index || !object(value.reference_entry)) throw invalid()
        return value.reference_entry
      } catch { signal.throwIfAborted(); throw invalid() }
    },
    async queueFace(rawScope: ImAttachmentScope, eventId: string, refs: readonly QqEmojiRef[], signal: AbortSignal): Promise<void> {
      const scope = normalized(rawScope)
      try {
        signal.throwIfAborted()
        const key = faceKey(scope), time = now()
        if (!Number.isSafeInteger(time) || time < 0 || !eventId) throw invalid()
        const expires = time + QQ_FACE_PENDING_MS
        const data = JSON.stringify(sealed(scope, eventId, { face_refs: refs }))
        const result = await evalCommand(queueScript, [key, `${key}:queued:${hash(eventId)}`], [JSON.stringify({ expires, data }), String(pendingLimit)])
        if (result !== 1 && result !== '1') throw invalid()
      } catch { signal.throwIfAborted(); throw invalid() }
    },
    async takeFace(rawScope: ImAttachmentScope, eventId: string, signal: AbortSignal): Promise<QqEmojiRef[]> {
      const scope = normalized(rawScope)
      try {
        signal.throwIfAborted()
        const key = faceKey(scope), time = now()
        if (!Number.isSafeInteger(time) || time < 0 || !eventId) throw invalid()
        const raw = await evalCommand(popScript, [key, `${key}:paired:${hash(eventId)}`], [String(time)])
        if (raw === '-') return []
        if (typeof raw !== 'string') throw invalid()
        const value = opened(scope, raw)
        // FIFO必须本人配对，不能借群scope引用读取规则接受其他成员的队列包。
        if (value.platform_user_id !== scope.platformUserId || !Array.isArray(value.face_refs) || value.face_refs.some(ref => !object(ref) || typeof ref.face_type !== 'string' || typeof ref.face_id !== 'string')) throw invalid()
        return value.face_refs as QqEmojiRef[]
      } catch { signal.throwIfAborted(); throw invalid() }
    },
  }
}
