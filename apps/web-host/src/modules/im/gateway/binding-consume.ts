import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ImPreflightScope } from '@gugu/core/im/inbound-preflight'
import { normalizeOwnerId } from '../../../shared/owner-context.js'
import { withPostgresTransaction } from '../../../adapters/database/postgres-transaction.js'
import type { RedisCommandClient } from '../../../workers/redis-stream-queue.js'

/** 与现有issuer/Python共用挑战和预算；验证时不删除，数据库失败后原码仍可重试。 */
export const IM_BINDING_VALIDATE_SCRIPT = `
local function kind(key)
 local value=redis.call('TYPE',key)
 if type(value)=='table' then return value.ok end
 return value
end
local challenge_kind,attempt_kind=kind(KEYS[1]),kind(KEYS[2])
if (challenge_kind~='none' and challenge_kind~='string') or (attempt_kind~='none' and attempt_kind~='string') then
 return redis.error_reply('IM binding key type invalid')
end
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local count=redis.call('GET',KEYS[2])
if count and (not string.match(count,'^%d+$') or #count>9) then return redis.error_reply('IM binding attempts invalid') end
if tonumber(count or '0')>=5 then return 0 end
-- 正确码只校验既有失败预算；PG失败不应耗尽它，成功由同事务持久收据一次性消费。
if ARGV[2]=='1' then return 1 end
local attempts=redis.call('INCR',KEYS[2])
if attempts==1 then redis.call('EXPIRE',KEYS[2],600) end
return 0
`
/** 精确比较旧挑战，不能删除已重新签发的新码。 */
export const IM_BINDING_CLEANUP_SCRIPT = `
local kind=redis.call('TYPE',KEYS[1])
if type(kind)=='table' then kind=kind.ok end
if kind~='none' and kind~='string' then return redis.error_reply('IM binding key type invalid') end
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('DEL',KEYS[1],KEYS[2])
return 1
`
export class ImBindingUnavailable extends Error {
  constructor() { super('IM 绑定暂时不可用'); this.name = 'ImBindingUnavailable' }
}
export interface ImBindingResult {
  readonly bound: boolean
  readonly changed: boolean
  /** pending表示数据库已提交，Redis清理或通知仍待恢复；不表示绑定回滚。 */
  readonly postCommit: 'complete' | 'pending'
}
type BindingScope = ImPreflightScope & { readonly platform: 'qq' | 'telegram' }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const unchanged = (bound = false): ImBindingResult => ({ bound, changed: false, postCommit: 'complete' })
function bindingScope(raw: ImPreflightScope): BindingScope | null {
  if (raw.chatType !== 'c2c' || raw.chatId !== null || !['qq', 'telegram'].includes(raw.platform)) return null
  try {
    if (!/^[1-9]\d{0,9}$/.test(raw.botId) || Number(raw.botId) > 2_147_483_647 || !raw.platformUserId
      || raw.platformUserId.length > 128 || /[\r\n\0]/.test(raw.platformUserId)
      || raw.platform === 'telegram' && !/^[1-9]\d*$/.test(raw.platformUserId)) throw new ImBindingUnavailable()
    return Object.freeze({ ...raw, ownerId: normalizeOwnerId(raw.ownerId), platform: raw.platform as 'qq' | 'telegram' })
  } catch { throw new ImBindingUnavailable() }
}

/** 单一Node消费归属下使用；Python不能同时消费同Bot的绑定挑战。无跨库伪事务。 */
export function createPostgresRedisBindingConsumer(options: {
  pool: Pick<Pool, 'connect'>
  redis: RedisCommandClient
  secretKey: string
  /** 提交后清除本地权限/快照缓存；不得记录scope或code。 */
  invalidate(scope: ImPreflightScope): void
  publishChanged(ownerId: string): Promise<void>
  report(event: 'post-commit-pending'): void
}) {
  if (!options.secretKey) throw new ImBindingUnavailable()
  const secret = options.secretKey
  async function bot(client: PoolClient, scope: BindingScope): Promise<Record<string, unknown> | null> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT b.id::text AS id,b.user_id::text AS owner_id,b.platform,b.owner_platform_user_id
       FROM user_bots b JOIN users u ON u.id=b.user_id
       WHERE b.id=$1::integer AND b.user_id=$2::uuid AND b.platform=$3
         AND b.enabled IS TRUE AND u.is_active IS TRUE AND COALESCE(u.account_status,'active')='active'
       FOR UPDATE OF b,u`, [scope.botId, scope.ownerId, scope.platform])
    const row = rows[0]
    if (!row) return null
    if (rows.length !== 1 || row.id !== scope.botId || row.owner_id !== scope.ownerId || row.platform !== scope.platform
      || row.owner_platform_user_id !== null && typeof row.owner_platform_user_id !== 'string') throw new ImBindingUnavailable()
    return row
  }
  async function update(client: PoolClient, scope: BindingScope): Promise<void> {
    const result = await client.query(
      `UPDATE user_bots SET owner_platform_user_id=$4,owner_bound_at=clock_timestamp()
       WHERE id=$1::integer AND user_id=$2::uuid AND platform=$3 AND owner_platform_user_id IS NULL
       RETURNING id`, [scope.botId, scope.ownerId, scope.platform, scope.platformUserId])
    if (result.rows.length !== 1) throw new ImBindingUnavailable()
    // 与绑定在同一事务提交；现有监督器只把通知视为重新读取权威配置的信号。
    await client.query("SELECT pg_notify('im_gateway_reload','')")
  }
  async function afterCommit(scope: BindingScope, cleanup?: () => Promise<void>): Promise<ImBindingResult> {
    let pending = false
    try { options.invalidate(scope) } catch { pending = true }
    try { await options.publishChanged(scope.ownerId) } catch { pending = true }
    try { await cleanup?.() } catch { pending = true }
    if (pending) { try { options.report('post-commit-pending') } catch { /* 诊断不能改变已提交事实。 */ } }
    return { bound: true, changed: true, postCommit: pending ? 'pending' : 'complete' }
  }
  async function consume(rawScope: ImPreflightScope, code: string, signal?: AbortSignal): Promise<ImBindingResult> {
    const scope = bindingScope(rawScope)
    const normalized = typeof code === 'string' ? code.replace(/[\s\u0085\u001c-\u001f]/gu, '') : ''
    if (!scope || !/^[0-9]{6}$/.test(normalized)) return unchanged()
    let cleanup: (() => Promise<void>) | undefined
    try {
      signal?.throwIfAborted()
      const result = await withPostgresTransaction(options.pool, async client => {
        signal?.throwIfAborted()
        const current = await bot(client, scope)
        if (!current) return unchanged()
        // Python QQ同sender重复事件幂等；Telegram必须每次有尚未消费的有效挑战。
        if (current.owner_platform_user_id !== null) return unchanged(scope.platform === 'qq' && current.owner_platform_user_id === scope.platformUserId)
        const key = `im:${scope.platform}-binding:${scope.botId}`
        const raw = await options.redis.sendCommand(['GET', key])
        if (typeof raw !== 'string' || raw.length > 2048) return unchanged()
        let payload: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unchanged()
          payload = parsed as Record<string, unknown>
        } catch { return unchanged() }
        if (payload.user_id !== scope.ownerId || typeof payload.challenge_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.challenge_id)
          || typeof payload.code_hash !== 'string' || !/^[0-9a-f]{64}$/.test(payload.code_hash)) return unchanged()
        const challenge = digest(`${scope.platform}:${scope.botId}:${scope.ownerId}:${payload.challenge_id}`)
        const receipt = await client.query('SELECT 1 FROM gugu_im_binding_consumptions WHERE platform=$1 AND bot_id=$2::integer AND challenge_digest=$3',
          [scope.platform, scope.botId, challenge])
        if (receipt.rows.length) return unchanged()
        const attempts = `im:${scope.platform}-binding-attempts:${scope.botId}:${payload.challenge_id}`
          + (scope.platform === 'qq' ? `:${digest(scope.platformUserId).slice(0, 16)}` : '')
        const expected = createHmac('sha256', secret).update(`${scope.platform === 'qq' ? '' : 'telegram:'}${scope.botId}:${scope.ownerId}:${normalized}`).digest('hex')
        const matches = timingSafeEqual(Buffer.from(payload.code_hash, 'hex'), Buffer.from(expected, 'hex'))
        const verified = await options.redis.sendCommand(['EVAL', IM_BINDING_VALIDATE_SCRIPT, '2', key, attempts, raw, matches ? '1' : '0'])
        if (verified !== 1 && verified !== '1') return unchanged()
        signal?.throwIfAborted()
        await client.query(`INSERT INTO gugu_im_binding_consumptions(platform,bot_id,owner_id,challenge_digest,sender_digest)
          VALUES($1,$2::integer,$3::uuid,$4,$5)`, [scope.platform, scope.botId, scope.ownerId, challenge, digest(scope.platformUserId)])
        await update(client, scope)
        signal?.throwIfAborted()
        cleanup = async () => {
          const result = await options.redis.sendCommand(['EVAL', IM_BINDING_CLEANUP_SCRIPT, '2', key, attempts, raw])
          if (![0, 1, '0', '1'].includes(result as string | number)) throw new ImBindingUnavailable()
        }
        return { bound: true, changed: true, postCommit: 'complete' as const }
      })
      return result.changed ? await afterCommit(scope, cleanup) : result
    } catch { throw new ImBindingUnavailable() }
  }
  async function bindFirstQqOwner(rawScope: ImPreflightScope, signal?: AbortSignal): Promise<ImBindingResult> {
    const scope = bindingScope(rawScope)
    if (!scope || scope.platform !== 'qq') return unchanged()
    try {
      signal?.throwIfAborted()
      const changed = await withPostgresTransaction(options.pool, async client => {
        signal?.throwIfAborted()
        const current = await bot(client, scope)
        if (!current || current.owner_platform_user_id !== null) return false
        await update(client, scope)
        signal?.throwIfAborted()
        return true
      })
      return changed ? await afterCommit(scope) : unchanged()
    } catch { throw new ImBindingUnavailable() }
  }
  return {
    consume, bindFirstQqOwner,
    async consumeBinding(scope: ImPreflightScope, code: string, signal: AbortSignal): Promise<boolean> {
      return (await consume(scope, code, signal)).bound
    },
    async bindQqOwnerIfUnbound(scope: ImPreflightScope, signal: AbortSignal): Promise<void> {
      await bindFirstQqOwner(scope, signal)
    },
  }
}
