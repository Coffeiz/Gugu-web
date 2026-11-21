import type { ImPlatformProjectionStore } from '@gugu/gateway'
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import type { ImRunDeliveryPorts } from '@gugu/core/im/run-delivery'
import { createImAcceptedEvidenceCodec, type ImDeliveryLedgerContext } from '../attention/ledger.js'

export type ImDeliveryReceipts = ImRunDeliveryPorts<unknown>['receipts']
export type { ImPlatformProjectionStore }
export type ImDeliverySession = ImDeliveryReceipts & { projection?: ImPlatformProjectionStore }
export class ImDeliveryStoreError extends Error {
  constructor(readonly code: 'busy' | 'lease_lost' | 'storage_failure' | 'not_found' | 'conflict') {
    super('IM 投递存储操作未完成'); this.name = 'ImDeliveryStoreError'
  }
}

function scope(identity: RunIdentity): [string, number, string] {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(identity.ownerId)
    || !/^[1-9]\d*$/.test(identity.sessionId) || !Number.isSafeInteger(Number(identity.sessionId))
    || Number(identity.sessionId) > 2147483647 || !identity.runId || identity.runId.length > 128)
    throw new TypeError('IM 运行身份无效')
  return [identity.ownerId.toLowerCase(), Number(identity.sessionId), identity.runId]
}

/**
 * 专用连接的会话级advisory lock包围整个Core start/recover，网络请求不放进数据库事务。
 * 连接丢失不会自动重连：已登记pending保持未知，另一进程不得重发。
 * schema只由经审查的显式迁移创建；这里不执行DDL。
 */
export async function withPostgresImDeliveryStore<T>(pool: Pick<Pool, 'connect'>, identity: RunIdentity,
  work: (receipts: ImDeliverySession) => Promise<T>, projectionOptions?: { secretKey: string; platform?: 'feishu' | 'qq' | 'telegram'; ledger?: ImDeliveryLedgerContext }): Promise<T> {
  const values = scope(identity)
  const ledger = projectionOptions?.ledger ? createImAcceptedEvidenceCodec(projectionOptions.secretKey, projectionOptions.ledger) : null
  const hash = createHash('sha256').update(JSON.stringify(['gugu-im-delivery', ...values])).digest()
  const keys = [hash.readInt32BE(0), hash.readInt32BE(4)]
  let client: PoolClient
  try { client = await pool.connect() } catch { throw new ImDeliveryStoreError('storage_failure') }
  let active = true, lost = false, locked = false, busy = false, accepting = true
  // Telegram临时draft保活与Core外层begin/settle共享该连接；仅此显式模式允许有界生命周期内排队。
  const serializeOperations = projectionOptions?.platform === 'telegram'
  let operationTail: Promise<void> = Promise.resolve()
  let backendPid: number | null = null
  const attempts = new Map<string, string>()
  const onLost = () => { lost = true }
  client.on('error', onLost)
  client.on('end', onLost)
  async function query<R extends QueryResultRow>(text: string, params: unknown[] = []) {
    if (!active || lost) throw new ImDeliveryStoreError('lease_lost')
    try { return await client.query<R>(text, params) }
    catch { lost = true; throw new ImDeliveryStoreError('storage_failure') }
  }
  async function assertLease(target: RunIdentity): Promise<void> {
    if (JSON.stringify(scope(target)) !== JSON.stringify(values)) throw new ImDeliveryStoreError('not_found')
    const result = await query<{ backend_pid: number; held: boolean }>(`SELECT pg_backend_pid() AS backend_pid, EXISTS (
      SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
        AND classid::bigint=$1 AND objid::bigint=$2 AND objsubid=2) AS held`, [keys[0]! >>> 0, keys[1]! >>> 0])
    if (result.rows[0]?.backend_pid !== backendPid || result.rows[0]?.held !== true) {
      lost = true; throw new ImDeliveryStoreError('lease_lost')
    }
  }
  async function operation<R>(target: RunIdentity, fn: () => Promise<R>): Promise<R> {
    if (!accepting || !active) throw new ImDeliveryStoreError('lease_lost')
    const execute = async () => {
      if (busy) throw new ImDeliveryStoreError('conflict')
      busy = true
      try { await assertLease(target); return await fn() } finally { busy = false }
    }
    if (!serializeOperations) return execute()
    const result = operationTail.then(execute)
    operationTail = result.then(() => undefined, () => undefined)
    return result
  }
  try {
    const lock = await query<{ locked: boolean; backend_pid: number }>(
      'SELECT pg_try_advisory_lock($1,$2) AS locked,pg_backend_pid() AS backend_pid', keys)
    if (lock.rows[0]?.locked !== true) throw new ImDeliveryStoreError('busy')
    locked = true; backendPid = lock.rows[0].backend_pid
    if (!Number.isSafeInteger(backendPid)) throw new ImDeliveryStoreError('lease_lost')
    await assertLease(identity)
    // 明确会话归属后才建立出站游标；不创建Agent运行或改变其状态。
    await query(`INSERT INTO gugu_im_run_delivery(user_id,session_id,run_id)
      SELECT s.user_id,s.id,$3 FROM conversation_sessions s WHERE s.user_id=$1 AND s.id=$2
      ON CONFLICT(user_id,session_id,run_id) DO NOTHING`, values)
    const owned = `FROM gugu_im_run_delivery d JOIN conversation_sessions s ON s.id=d.session_id AND s.user_id=d.user_id
      WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3`
    const receipts: ImDeliverySession = {
      cursor: target => operation(target, async () => {
        const result = await query<{ cursor: string | number }>(`SELECT d.cursor ${owned}`, values)
        if (!result.rows.length) throw new ImDeliveryStoreError('not_found')
        const cursor = Number(result.rows[0]!.cursor)
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ImDeliveryStoreError('conflict')
        return cursor
      }),
      begin: (target, key, fingerprint) => operation(target, async () => {
        if (!key || key.length > 200 || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError('IM 投递标识无效')
        const attempt = randomUUID()
        const result = await query<{ state: 'pending' | 'accepted' | 'unknown'; attempt_id: string }>(`INSERT INTO gugu_im_delivery_receipts(user_id,session_id,run_id,delivery_key,fingerprint,state,attempt_id)
          SELECT d.user_id,d.session_id,d.run_id,$4,$5,'pending',$6 ${owned}
          ON CONFLICT(user_id,session_id,run_id,delivery_key) DO UPDATE SET
            state=CASE WHEN gugu_im_delivery_receipts.state='rejected' THEN 'pending' ELSE gugu_im_delivery_receipts.state END,
            attempt_id=CASE WHEN gugu_im_delivery_receipts.state='rejected' THEN EXCLUDED.attempt_id ELSE gugu_im_delivery_receipts.attempt_id END
          WHERE gugu_im_delivery_receipts.fingerprint=EXCLUDED.fingerprint
          RETURNING state,attempt_id`, [...values, key, fingerprint, attempt])
        const row = result.rows[0]
        if (!row) throw new ImDeliveryStoreError('conflict')
        if (row.state === 'pending' && row.attempt_id === attempt) { attempts.set(key, attempt); return 'new' }
        return row.state
      }),
      settle: (target, key, result, evidence, event) => operation(target, async () => {
        if (!['accepted', 'rejected', 'unknown'].includes(result)) throw new TypeError('IM 投递状态无效')
        const attempt = attempts.get(key)
        if (!attempt) throw new ImDeliveryStoreError('conflict')
        if (evidence !== undefined && (!ledger || !event)) throw new ImDeliveryStoreError('conflict')
        if (ledger && result === 'accepted' && event) {
          if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.final && event.eventType !== 'final') throw new ImDeliveryStoreError('conflict')
          const encrypted = ledger.seal(target,key,attempt,evidence)
          // HTTP之后唯一提交点：证据约束/写入失败时，accepted更新一起回滚，原pending不允许重发。
          const updated = await query(`WITH accepted AS (
            UPDATE gugu_im_delivery_receipts r SET state='accepted'
              WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.delivery_key=$4 AND r.attempt_id=$5 AND r.state='pending'
                AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.id=r.session_id AND s.user_id=r.user_id)
              RETURNING r.user_id,r.session_id,r.run_id,r.delivery_key,r.attempt_id
          ) INSERT INTO gugu_im_accepted_delivery_facts(user_id,session_id,run_id,delivery_key,attempt_id,scope_hash,event_sequence,final_event_sequence,final_confirmed_at,nonce,payload)
            SELECT user_id,session_id,run_id,delivery_key,attempt_id,$6,$7,$8,CASE WHEN $8::bigint IS NOT NULL THEN clock_timestamp() END,$9,$10 FROM accepted RETURNING delivery_key`,
          [...values,key,attempt,ledger.scopeHash,event.sequence,event.final ? event.sequence : null,encrypted.nonce,encrypted.payload])
          if (updated.rowCount !== 1) throw new ImDeliveryStoreError('conflict')
          attempts.delete(key)
          return
        }
        const updated = await query(`UPDATE gugu_im_delivery_receipts r SET state=$6
          WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.delivery_key=$4 AND r.attempt_id=$5 AND r.state='pending'
            AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.id=r.session_id AND s.user_id=r.user_id)
          RETURNING r.delivery_key`, [...values, key, attempt, result])
        if (updated.rowCount !== 1) throw new ImDeliveryStoreError('conflict')
        attempts.delete(key)
      }),
      confirmFinal: (target,key,fingerprint,event) => operation(target, async () => {
        if (!ledger) return // 兼容旧调用；reader不会把缺少证据的旧收据当完整覆盖。
        if (!key || key.length > 200 || !/^[a-f0-9]{64}$/.test(fingerprint) || event.eventType !== 'final' || !event.final
          || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new ImDeliveryStoreError('conflict')
        const updated = await query(`UPDATE gugu_im_accepted_delivery_facts f SET final_event_sequence=$6,final_confirmed_at=COALESCE(f.final_confirmed_at,clock_timestamp())
          FROM gugu_im_delivery_receipts r WHERE f.user_id=$1 AND f.session_id=$2 AND f.run_id=$3 AND f.delivery_key=$4
            AND r.user_id=f.user_id AND r.session_id=f.session_id AND r.run_id=f.run_id AND r.delivery_key=f.delivery_key
            AND r.state='accepted' AND r.attempt_id=f.attempt_id AND r.fingerprint=$5 AND f.scope_hash=$7
            AND f.event_sequence<=$6 AND (f.final_event_sequence IS NULL OR f.final_event_sequence=$6)
            AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.id=f.session_id AND s.user_id=f.user_id)
          RETURNING f.delivery_key`,[...values,key,fingerprint,event.sequence,ledger.scopeHash])
        // 旧收据无证据不伪造送达时间或正文；明确留作不完整覆盖。
        if (updated.rowCount !== 1) {
          const old = await query(`SELECT 1 FROM gugu_im_delivery_receipts r WHERE r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.delivery_key=$4
            AND r.fingerprint=$5 AND r.state='accepted' AND NOT EXISTS(SELECT 1 FROM gugu_im_accepted_delivery_facts f
              WHERE f.user_id=r.user_id AND f.session_id=r.session_id AND f.run_id=r.run_id AND f.delivery_key=r.delivery_key)`,[...values,key,fingerprint])
          if (old.rowCount !== 1) throw new ImDeliveryStoreError('conflict')
        }
      }),
      advance: (target, expected, next) => operation(target, async () => {
        if (!Number.isSafeInteger(expected) || expected < 0 || next !== expected + 1 || !Number.isSafeInteger(next)) throw new TypeError('IM 投递游标无效')
        const updated = await query(`UPDATE gugu_im_run_delivery d SET cursor=$5
          WHERE d.user_id=$1 AND d.session_id=$2 AND d.run_id=$3 AND d.cursor=$4
            AND EXISTS(SELECT 1 FROM conversation_sessions s WHERE s.id=d.session_id AND s.user_id=d.user_id)
          RETURNING d.cursor`, [...values, expected, next])
        if (updated.rowCount !== 1) throw new ImDeliveryStoreError('conflict')
      }),
    }
    if (projectionOptions) {
      if (!projectionOptions.secretKey) throw new ImDeliveryStoreError('conflict')
      const platform = projectionOptions.platform ?? 'feishu'
      if (!['feishu', 'qq', 'telegram'].includes(platform)) throw new ImDeliveryStoreError('conflict')
      const key = Buffer.from(hkdfSync('sha256', Buffer.from(projectionOptions.secretKey), Buffer.alloc(0), Buffer.from(`gugu-im-${platform}-projection-v1`), 32))
      const aad = (version: number) => Buffer.from(JSON.stringify([platform, ...values, version]))
      const encrypt = (state: unknown, version: number) => {
        let json: string
        try { json = JSON.stringify(state); if (!json || Buffer.byteLength(json) > 1048576) throw Error() } catch { throw new ImDeliveryStoreError('conflict') }
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad(version))
        return { nonce, payload: Buffer.concat([cipher.update(json), cipher.final(), cipher.getAuthTag()]) }
      }
      async function save(expected: number, state: unknown, receiptKey?: string): Promise<number> {
        if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER) throw new ImDeliveryStoreError('conflict')
        const version = expected + 1, encrypted = encrypt(state, version), attempt = receiptKey ? attempts.get(receiptKey) : null
        if (receiptKey && !attempt) throw new ImDeliveryStoreError('conflict')
        const result = await query<{ version: string }>(`WITH permitted AS (
          SELECT d.user_id,d.session_id,d.run_id ${owned}
          AND (EXISTS(SELECT 1 FROM gugu_im_platform_projection p WHERE p.user_id=d.user_id AND p.session_id=d.session_id AND p.run_id=d.run_id AND p.platform=$10 AND p.version=$4)
            OR ($4=0 AND NOT EXISTS(SELECT 1 FROM gugu_im_platform_projection p WHERE p.user_id=d.user_id AND p.session_id=d.session_id AND p.run_id=d.run_id AND p.platform=$10)))
        ), accepted AS (
          UPDATE gugu_im_delivery_receipts r SET state='accepted' WHERE $8::text IS NOT NULL
            AND r.user_id=$1 AND r.session_id=$2 AND r.run_id=$3 AND r.delivery_key=$8 AND r.attempt_id=$9::uuid AND r.state='pending'
            AND EXISTS(SELECT 1 FROM permitted) RETURNING r.delivery_key
        ) INSERT INTO gugu_im_platform_projection(user_id,session_id,run_id,platform,version,nonce,payload)
          SELECT user_id,session_id,run_id,$10,$5,$6,$7 FROM permitted WHERE $8::text IS NULL OR EXISTS(SELECT 1 FROM accepted)
          ON CONFLICT(user_id,session_id,run_id,platform) DO UPDATE SET version=EXCLUDED.version,nonce=EXCLUDED.nonce,payload=EXCLUDED.payload
            WHERE gugu_im_platform_projection.version=$4 RETURNING version`, [...values, expected, version, encrypted.nonce, encrypted.payload, receiptKey ?? null, attempt, platform])
        if (result.rows.length !== 1 || Number(result.rows[0]!.version) !== version) throw new ImDeliveryStoreError('conflict')
        if (receiptKey) attempts.delete(receiptKey)
        return version
      }
      receipts.projection = {
        platform,
        read: () => operation(identity, async () => {
          const result = await query<{ version: string; nonce: Buffer; payload: Buffer }>(`SELECT p.version,p.nonce,p.payload FROM gugu_im_platform_projection p
            JOIN gugu_im_run_delivery d ON d.user_id=p.user_id AND d.session_id=p.session_id AND d.run_id=p.run_id
            WHERE p.user_id=$1 AND p.session_id=$2 AND p.run_id=$3 AND p.platform=$4`, [...values, platform])
          if (!result.rows.length) return { version: 0, state: null }
          try {
            const row = result.rows[0]!, version = Number(row.version)
            if (!Number.isSafeInteger(version) || version < 1 || row.nonce.length !== 12 || row.payload.length < 16 || row.payload.length > 1048592) throw Error()
            const cipher = createDecipheriv('aes-256-gcm', key, row.nonce); cipher.setAAD(aad(version)); cipher.setAuthTag(row.payload.subarray(-16))
            return { version, state: JSON.parse(Buffer.concat([cipher.update(row.payload.subarray(0, -16)), cipher.final()]).toString('utf8')) as unknown }
          } catch { throw new ImDeliveryStoreError('conflict') }
        }),
        checkpoint: (expected, state) => operation(identity, () => save(expected, state)),
        accepted: (receiptKey, expected, state) => operation(identity, () => save(expected, state, receiptKey)),
      }
    }
    return await work(receipts)
  } finally {
    accepting = false
    // 已接受的Telegram SQL必须在同一租约内排空；关闭后新调用不得加入队列。
    if (serializeOperations) await operationTail
    active = false
    // 调用方遗漏await时不得把仍有查询的连接解锁后交还池，避免旧借用污染下一次投递。
    if (busy) lost = true
    if (locked && !lost) {
      try {
        const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock($1,$2) AS unlocked', keys)
        if (result.rows[0]?.unlocked !== true) lost = true
      } catch { lost = true }
    }
    client.removeListener('error', onLost)
    client.removeListener('end', onLost)
    client.release(lost)
  }
}
