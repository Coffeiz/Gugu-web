import { createHash, randomUUID } from 'node:crypto'
import type { CanonicalCompletionInput, RunIdentity } from '@gugu/core/agent'
import type { Pool } from 'pg'
import type { createReflectionModelScope } from '../../agent/model-config/recoverable-provider.js'

const namespace = 'agent:reflection:owner'
const idleKey = `${namespace}:idle`
const idleSeconds = 180
const dedupeSeconds = 7 * 24 * 60 * 60
const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const validSession = (id: string) => /^[1-9]\d*$/u.test(id) && Number.isSafeInteger(Number(id))
const memberKey = (owner: string, session: string) => `${owner}:${session}`
const bufferKey = (member: string) => `${namespace}:turns:${member}`
const batchKey = (member: string) => `${namespace}:batch:${member}`
const leaseKey = (owner: string) => `${namespace}:lease:${owner}`
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

const TRIVIAL = new Set(['嗯','嗯嗯','嗯呢','好','好的','好滴','好哒','行','行吧','成','中','哦','哦哦','噢','ok','okay','okk','k','谢谢','谢了','多谢','thanks','thx','收到','了解','明白','懂了','哈哈','哈哈哈','嘿嘿','可以','对','对的','是','是的','没了','没事','不用了','辛苦了','👍','👌','🙏','666','赞','嗯嗯嗯'])
const TRIM = /^[ \t\n　。，、！？～~.,!?;:…“”"'（）()【】\[\]]+|[ \t\n　。，、！？～~.,!?;:…“”"'（）()【】\[\]]+$/gu

export interface AgentReflectionRedisCommands {
  eval(script: string, keyCount: number, ...args: string[]): Promise<string | null>
}

export interface AgentReflectionTurn {
  identity: RunIdentity
  userMessageId: string
  modelIdentity: string
  accessScopeHash: string
  userMessage: string
  usedTools: boolean
}

const append = `
  if redis.call('EXISTS',KEYS[3]) == 1 then return 0 end
  local count = redis.call('RPUSH',KEYS[1],ARGV[1])
  redis.call('SET',KEYS[3],'1','EX',ARGV[5])
  if redis.call('EXISTS',KEYS[4]) == 0 then
    local due = tonumber(ARGV[2])
    if count >= tonumber(ARGV[3]) then due = due - tonumber(ARGV[4]) end
    redis.call('ZADD',KEYS[2],due,ARGV[6])
  end
  return count`

/** 同一 Run 重复收尾只追加一次。领取模型任务期间可以继续追加。 */
export function createRedisAgentReflectionQueue(options: {
  commands: AgentReflectionRedisCommands; modelScope: ReturnType<typeof createReflectionModelScope>; now?: () => number
}) {
  const now = options.now ?? Date.now
  return async function enqueue(input: AgentReflectionTurn, threshold: number): Promise<boolean> {
    const { ownerId, sessionId, runId } = input.identity
    if (!ownerPattern.test(ownerId) || !validSession(sessionId) || !validSession(input.userMessageId)
      || !runId || !input.modelIdentity || !input.accessScopeHash)
      throw new TypeError('Agent 反思队列身份无效')
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 100)
      throw new RangeError('Agent 反思队列阈值无效')
    const meaningful = input.userMessage.replace(TRIM, '').trim().toLowerCase()
    if (!input.usedTools && (!meaningful || TRIVIAL.has(meaningful))) return false
    const timestamp = now() / 1000
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw new RangeError('Agent 反思队列时钟无效')
    const member = memberKey(ownerId, sessionId)
    const modelScope = options.modelScope(input.identity, input)
    const payload = JSON.stringify({ runId, userMessageId: input.userMessageId, modelIdentity: input.modelIdentity,
      accessScopeHash: input.accessScopeHash, modelScope, timestamp, threshold })
    const result = await options.commands.eval(append, 4, bufferKey(member), idleKey,
      `${namespace}:seen:${digest(JSON.stringify([ownerId, sessionId, runId]))}`, batchKey(member), payload, String(timestamp),
      String(threshold), String(idleSeconds), String(dedupeSeconds), member)
    if (result === null || !/^\d+$/u.test(result)) throw new Error('Agent 反思队列回执无效')
    return true
  }
}

export async function clearRedisAgentReflectionSession(commands: AgentReflectionRedisCommands, owner: string, session: string) {
  if (!ownerPattern.test(owner) || !validSession(session)) throw new TypeError('Agent 反思队列身份无效')
  const member = memberKey(owner, session)
  await commands.eval("redis.call('DEL',KEYS[1],KEYS[3]); return redis.call('ZREM',KEYS[2],ARGV[1])",
    3, bufferKey(member), idleKey, batchKey(member), member)
}

const dueMembers = "return cjson.encode(redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,100))"
const take = `
  local due = redis.call('ZSCORE',KEYS[2],ARGV[1])
  if not due or tonumber(due) > tonumber(ARGV[2]) then return nil end
  local frozen = tonumber(redis.call('GET',KEYS[4]))
  local rows = redis.call('LRANGE',KEYS[1],0,(frozen or 100)-1)
  if #rows == 0 then redis.call('ZREM',KEYS[2],ARGV[1]); return nil end
  if not frozen then
    local first = cjson.decode(rows[1])
    for i=2,#rows do
      local row = cjson.decode(rows[i])
      if not first.modelScope or row.modelScope ~= first.modelScope then
        for j=i,#rows do rows[j] = nil end
        break
      end
    end
  end
  if not redis.call('SET',KEYS[3],ARGV[3],'NX','PX',ARGV[4]) then return nil end
  redis.call('SET',KEYS[4],#rows)
  return cjson.encode(rows)`
const settle = `
  if redis.call('GET',KEYS[3]) ~= ARGV[1] then return 0 end
  local expected = cjson.decode(ARGV[3])
  local actual = redis.call('LRANGE',KEYS[1],0,#expected-1)
  local same = #actual == #expected
  for i=1,#actual do if actual[i] ~= expected[i] then same = false end end
  if ARGV[6] == 'check' then return same and 1 or 0 end
  if same then
    if ARGV[6] == 'split' then
      redis.call('SET',KEYS[4],math.floor(#expected / 2))
    elseif ARGV[4] == '' then
      local remaining = redis.call('LLEN',KEYS[1]) - #expected
      local score
      if remaining > 0 then
        local tail = cjson.decode(redis.call('LINDEX',KEYS[1],-1))
        score = tail.timestamp
        if remaining >= tail.threshold then score = score - tonumber(ARGV[5]) end
      end
      redis.call('LTRIM',KEYS[1],#expected,-1)
      redis.call('DEL',KEYS[4])
      if score then redis.call('ZADD',KEYS[2],score,ARGV[2])
      else redis.call('ZREM',KEYS[2],ARGV[2]) end
    else
      redis.call('ZADD',KEYS[2],'XX','GT',ARGV[4],ARGV[2])
    end
  end
  redis.call('DEL',KEYS[3])
  return same and 1 or 0`

/** 领取不移除源数据，批次 ID 可作为下游持久写入的幂等键。 */
export function createRedisAgentReflectionInbox(options: {
  commands: AgentReflectionRedisCommands; now?: () => number; leaseMs?: number
}) {
  const now = options.now ?? Date.now
  const leaseMs = options.leaseMs ?? 180_000
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new RangeError('反思租约无效')
  return async function claim() {
    const cutoff = String(now() / 1000 - idleSeconds)
    const raw = await options.commands.eval(dueMembers, 1, idleKey, cutoff)
    const members: unknown = raw === null ? [] : JSON.parse(raw)
    // Redis Lua 将空表编码成 {}。
    if (!Array.isArray(members)) return null
    for (const member of members) {
      if (typeof member !== 'string') continue
      const [ownerId, sessionId, extra] = member.split(':')
      if (!ownerId || !sessionId || extra !== undefined || !ownerPattern.test(ownerId) || !validSession(sessionId)) continue
      const token = randomUUID()
      const keys = [bufferKey(member), idleKey, leaseKey(ownerId), batchKey(member)] as const
      const payload = await options.commands.eval(take, 4, ...keys, member, cutoff, token, String(leaseMs))
      if (payload === null) continue
      const rows = JSON.parse(payload) as string[]
      const rowsJson = JSON.stringify(rows)
      const finish = async (retry: string, mode = 'settle') =>
        await options.commands.eval(settle, 4, ...keys, token, member, rowsJson, retry, String(idleSeconds), mode) === '1'
      const turns = rows.map(row => JSON.parse(row) as Omit<AgentReflectionTurn, 'identity' | 'usedTools' | 'userMessage'>
        & { runId: string; timestamp: number; modelScope: string })
      return {
        ownerId, sessionId, batchId: digest(JSON.stringify([member, rows])),
        turns,
        isCurrent: () => finish('', 'check'),
        complete: () => finish(''),
        split: () => rows.length > 1 ? finish('', 'split') : Promise.resolve(false),
        retry(delayMs: number) {
          if (!Number.isSafeInteger(delayMs) || delayMs < 0) throw new RangeError('反思重试间隔无效')
          return finish(String((now() + delayMs) / 1000 - idleSeconds))
        },
      }
    }
    return null
  }
}

/** 收尾读取本次已提交的 owner 消息，拒绝将其他会话或临时消息排入反思队列。 */
export function createWebAgentReflectionFinalizer(options: {
  pool: Pick<Pool, 'query'>
  enqueue: ReturnType<typeof createRedisAgentReflectionQueue>
  threshold(): number
  diagnose(): void
}) {
  return async function complete(input: CanonicalCompletionInput, enabled: boolean): Promise<void> {
    if (!enabled || !input.text.trim()) return
    const identity = input.identity
    const anchor = [...(input.request?.area.entries ?? [])].reverse().find(entry => entry.source === 'user'
      && entry.persistencePolicy === 'already_persisted' && entry.persistedMessageId)
    if (!anchor?.persistedMessageId) return
    try {
      const result = await options.pool.query<{ content: string }>(
        `SELECT m.content FROM conversation_messages m
         JOIN conversation_sessions s ON s.id=m.session_id AND s.user_id=$1
         WHERE s.id=$2 AND m.id=$3 AND m.role='user' AND m.run_id=$4`,
        [identity.ownerId, identity.sessionId, anchor.persistedMessageId, identity.runId],
      )
      const row = result.rows[0]
      if (!row || typeof row.content !== 'string') throw new Error('反思用户消息不可用')
      await options.enqueue({ identity, userMessageId: anchor.persistedMessageId, modelIdentity: input.modelIdentity,
        accessScopeHash: input.accessScopeHash, userMessage: row.content, usedTools: input.hadTools }, options.threshold())
    } catch {
      // 反思队列失败不改变已提交的聊天结果。
      options.diagnose()
    }
  }
}
