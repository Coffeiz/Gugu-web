import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import {
  IM_PENDING_ASK_MAX_WAIT_MS, IM_PENDING_ASK_MIN_WAIT_MS, IM_PENDING_ASK_QUIET_MS,
  type ImPendingAskResume, type ImPendingAskScope, type ImPendingAskTrigger,
} from '@gugu/gateway'
import type { RedisCommandClient } from '../../../../workers/redis-stream-queue.js'

/** 与Node持久派发保留期一致；Python旧取消水位仅600秒。 */
export const PENDING_ASK_RUN_PROOF_TTL_SECONDS = 7 * 24 * 60 * 60
const index = 'im:node:{pending-ask}:due:v1'
const prefix = 'im:node:{pending-ask}:v1:'
const failure = () => new Error('群延迟回复状态暂时不可用')
const identifier = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const time = (value: number) => Number.isSafeInteger(value) && value > 0
// 在任何写入前检查类型，避免Lua错误造成部分变更。索引只存不可逆scope摘要。
const header = `
local MIN_WAIT=${IM_PENDING_ASK_MIN_WAIT_MS}; local QUIET=${IM_PENDING_ASK_QUIET_MS}; local MAX_WAIT=${IM_PENDING_ASK_MAX_WAIT_MS}
for i,key in ipairs(KEYS) do
 local kind=redis.call('TYPE',key); if type(kind)=='table' then kind=kind.ok end
 local expected=i==2 and 'zset' or 'string'
 if kind~='none' and kind~=expected then return redis.error_reply('pending ask type invalid') end
end
local id=ARGV[1]; local at=tonumber(ARGV[2])
local raw=redis.call('GET',KEYS[1]); local s=raw and cjson.decode(raw) or nil
local function due(v) return math.min(math.max(v.started+MIN_WAIT,v.latest+MIN_WAIT,v.activity+QUIET),v.started+MAX_WAIT) end
local function save(v)
 redis.call('SET',KEYS[1],cjson.encode(v),'EX',600); redis.call('ZADD',KEYS[2],due(v),id)
end
`
const register = header + `
local cancelled=tonumber(redis.call('GET',KEYS[4]) or '0')
if cancelled>=at then return 0 end
if not s then
 if redis.call('ZCARD',KEYS[2])>=10000 and not redis.call('ZSCORE',KEYS[2],id) then return redis.error_reply('pending ask capacity') end
 s={started=at,latest=at,activity=at}
end
if at>=s.latest then s.latest=at; s.data=ARGV[3]; s.sender=ARGV[4]; s.message=ARGV[5]; s.event=ARGV[6] end
s.activity=math.max(s.activity,tonumber(redis.call('GET',KEYS[3]) or at))
s.resume=id..':'..string.format('%.0f',s.started)..':'..string.format('%.0f',s.latest)..':'..s.event
save(s); return s.resume
`
const observe = header + `
local activity=math.max(at,tonumber(redis.call('GET',KEYS[3]) or '0'))
redis.call('SET',KEYS[3],tostring(activity),'EX',600)
if ARGV[5]=='1' or (s and ARGV[4]~='' and s.message==ARGV[4] and s.sender~=ARGV[3]) then
 local cancelled=math.max(at,s and s.latest or 0,tonumber(redis.call('GET',KEYS[4]) or '0'))
 redis.call('SET',KEYS[4],tostring(cancelled),'EX',604800)
 redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],id); return 2
end
if not s then return 0 end
s.activity=math.max(s.activity,activity); save(s); return 1
`
const cancel = header + `
local cancelled=math.max(at,tonumber(redis.call('GET',KEYS[4]) or '0'))
redis.call('SET',KEYS[4],tostring(cancelled),'EX',604800)
redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],id); return 1
`
const claim = header + `
if not s then redis.call('ZREM',KEYS[2],id); return false end
if s.resume~=ARGV[3] then return false end
local ready=at>=s.latest+MIN_WAIT and at-s.activity>=QUIET
if at>=s.started+MAX_WAIT and not ready then
 redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],id); return false
end
if ready and due(s)<=at then
 redis.call('SET',KEYS[5],tostring(at),'EX',604800)
 redis.call('ZADD',KEYS[2],at+5000,id); return raw
end
redis.call('ZADD',KEYS[2],due(s),id); return false
`
const complete = header + `
if s and s.resume~=ARGV[3] then return 0 end
redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],id); return 1
`

/** Node独占状态；聊天、身份、平台token只存在于带scope AAD的密文，不能与Python消费者共享。 */
export function createRedisImPendingAskStore(options: { redis: RedisCommandClient; secretKey: string; now?(): number }) {
  if (!options.secretKey) throw failure()
  const now = options.now ?? Date.now
  const key = Buffer.from(hkdfSync('sha256', options.secretKey, '', 'gugu-node-pending-ask-v1', 32))
  const hash = (value: unknown) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex')
  function scopeId(scope: ImPendingAskScope): string {
    if (!object(scope) || !identifier(scope.ownerId) || !/^[1-9]\d*$/u.test(scope.botId)
      || !['qq', 'feishu', 'telegram'].includes(scope.platform) || !identifier(scope.groupId)) throw failure()
    return hash([scope.ownerId, scope.botId, scope.platform, scope.groupId])
  }
  const keys = (id: string) => [`${prefix}${id}`, index, `${prefix}activity:${id}`, `${prefix}cancelled:${id}`]
  async function call(script: string, id: string, at: number, args: string[] = [], extraKeys: string[] = []): Promise<unknown> {
    if (!time(at)) throw failure()
    try { return await options.redis.sendCommand(['EVAL', script, String(4 + extraKeys.length), ...keys(id), ...extraKeys, id, String(at), ...args]) } catch { throw failure() }
  }
  function seal(id: string, scope: ImPendingAskScope, trigger: ImPendingAskTrigger): string {
    try {
      const bytes = Buffer.from(JSON.stringify({ scope, trigger }))
      if (bytes.length > 1_048_576) throw failure()
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
      cipher.setAAD(Buffer.from(id))
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64')
    } catch { throw failure() }
  }
  function open(id: string, data: unknown): { scope: ImPendingAskScope; trigger: ImPendingAskTrigger } {
    if (typeof data !== 'string' || data.length > 1_500_000) throw failure()
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length < 28 || bytes.toString('base64') !== data) throw failure()
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(bytes.subarray(-16))
    const decoded: unknown = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'))
    if (!object(decoded) || !object(decoded.scope) || !object(decoded.trigger) || scopeId(decoded.scope as unknown as ImPendingAskScope) !== id) throw failure()
    return decoded as unknown as { scope: ImPendingAskScope; trigger: ImPendingAskTrigger }
  }
  const store = {
    /** 保留服务只读检查；不claim、续TTL或清理尚可唤醒的ASK。 */
    async hasPending(scope:ImPendingAskScope,signal?:AbortSignal):Promise<boolean>{
      signal?.throwIfAborted()
      const id=scopeId(scope)
      try{
        const raw=await options.redis.sendCommand(['GET',keys(id)[0]!])
        signal?.throwIfAborted()
        if(raw===null)return false
        if(typeof raw!=='string'||raw.length>1_600_000)throw failure()
        const state:unknown=JSON.parse(raw)
        if(!object(state)||!identifier(state.resume)||!time(Number(state.latest)))throw failure()
        open(id,state.data)
        return true
      }catch(error){if(signal?.aborted)throw error;throw failure()}
    },
    async isIssued(resume: ImPendingAskResume, signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted()
      const id = scopeId(resume.scope)
      if (!identifier(resume.resumeId) || resume.resumeId.length > 512) throw failure()
      try {
        const value = await options.redis.sendCommand(['GET', `${prefix}issued:${hash([id,resume.resumeId])}`])
        if (value === null) return false
        if (typeof value !== 'string' || !time(Number(value))) throw failure()
        return true
      } catch { throw failure() }
    },
    async register(scope: ImPendingAskScope, trigger: ImPendingAskTrigger, signal?: AbortSignal): Promise<string | null> {
      signal?.throwIfAborted()
      if (!identifier(trigger.eventId) || !identifier(trigger.senderId) || !identifier(trigger.platformMessageId) || !time(trigger.eventMs)
        || !object(trigger.payload) || Array.isArray(trigger.payload._batch_messages)) throw failure()
      const id = scopeId(scope)
      const result = await call(register, id, trigger.eventMs, [seal(id, scope, trigger), hash(trigger.senderId), hash(trigger.platformMessageId), hash(trigger.eventId)])
      return typeof result === 'string' ? result : null
    },
    async observe(scope: ImPendingAskScope, event: { eventMs: number; senderId: string; ownBotId?: string; replyTo?: string; directMention?: boolean }, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted()
      if (!identifier(event.senderId) || event.replyTo !== undefined && !identifier(event.replyTo)) throw failure()
      if (event.senderId === event.ownBotId) return
      await call(observe, scopeId(scope), event.eventMs, [hash(event.senderId), event.replyTo ? hash(event.replyTo) : '', event.directMention === true ? '1' : '0'])
    },
    async cancel(scope: ImPendingAskScope, eventMs: number, signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted(); await call(cancel, scopeId(scope), eventMs)
    },
    async isCancelled(resume: ImPendingAskResume, signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted()
      const id = scopeId(resume.scope)
      try { return Number(await options.redis.sendCommand(['GET', keys(id)[3]!])) >= resume.latestAskMs } catch { throw failure() }
    },
    async isCurrent(resume: ImPendingAskResume, signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted()
      const id = scopeId(resume.scope)
      try {
        const raw = await options.redis.sendCommand(['GET', keys(id)[0]!])
        if (raw === null) return false
        if (typeof raw !== 'string') throw failure()
        const state: unknown = JSON.parse(raw)
        return object(state) && state.resume === resume.resumeId
      } catch { throw failure() }
    },
    async claimDue(limit = 100, signal?: AbortSignal): Promise<ImPendingAskResume[]> {
      signal?.throwIfAborted()
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure()
      const at = now(); if (!time(at)) throw failure()
      try {
        const ids = await options.redis.sendCommand(['EVAL', "return redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,ARGV[2])", '1', index, String(at), String(limit)])
        if (!Array.isArray(ids)) throw failure()
        const result: ImPendingAskResume[] = []
        for (const id of ids) {
          signal?.throwIfAborted(); if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw failure()
          // 先读候选resume，再由同一claim Lua核对CAS并原子写issued证明；替换后的新ASK不能误领旧证明。
          const before = await options.redis.sendCommand(['GET', keys(id)[0]!])
          if (before === null) { await call(claim,id,at,[''],[`${prefix}issued:${hash([id,'missing'])}`]); continue }
          if (typeof before !== 'string') throw failure()
          const expected: unknown = JSON.parse(before)
          if (!object(expected) || !identifier(expected.resume) || expected.resume.length > 512) throw failure()
          const raw = await call(claim, id, at, [expected.resume], [`${prefix}issued:${hash([id,expected.resume])}`])
          if (raw === null || raw === false) continue
          if (typeof raw !== 'string') throw failure()
          const state: unknown = JSON.parse(raw)
          if (!object(state) || typeof state.resume !== 'string' || !time(Number(state.latest))) throw failure()
          result.push({ ...open(id, state.data), resumeId: state.resume, latestAskMs: Number(state.latest) })
        }
        return result
      } catch (error) { if (signal?.aborted) throw error; throw failure() }
    },
    async complete(resume: ImPendingAskResume, signal?: AbortSignal): Promise<boolean> {
      signal?.throwIfAborted()
      return await call(complete, scopeId(resume.scope), now(), [resume.resumeId]) === 1
    },
  }
  return store
}
