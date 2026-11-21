import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'
import { databaseTime, nowUtc } from '../../data/codec.js'
import { z } from 'zod'

export class QueueSessionNotFound extends Error { constructor() { super('对话不存在') } }
export class QueueConflict extends Error { constructor() { super('队列标识与会话不一致') } }
type Item = Record<string, unknown>
type Row = { sessionId: number | null; items: unknown }
type Db = Kysely<any>
export const pendingQueueAttachmentSchema = z.object({
  file_id: z.number().int().optional(), attach_id: z.string().max(128).optional(),
  name: z.string().max(512).optional(), ext: z.string().max(32).optional(),
  size: z.number().int().nonnegative().optional(), size_bytes: z.number().int().nonnegative().optional(),
  kind: z.string().max(32).optional(), mime: z.string().max(128).nullish(),
  qq_face: z.boolean().optional(), quoted: z.boolean().optional(), upload: z.boolean().optional(),
  duration: z.number().nonnegative().nullish(),
  img_width: z.number().int().nonnegative().nullish(), img_height: z.number().int().nonnegative().nullish(),
  transcript: z.string().max(8000).optional(),
})
export const pendingQueueReferenceSchema = z.object({ type: z.enum(['project', 'file', 'folder', 'event', 'conversation', 'canvas_note', 'skill', 'mcp', 'scheduled_task']), id: z.union([z.number().int().positive(), z.string().uuid()]), label: z.string().max(512) }).strict()
export const pendingQueueItemSchema = z.object({ key: z.number().int().positive(), text: z.string().max(200_000), attachments: z.array(pendingQueueAttachmentSchema).max(32).default([]), references: z.array(pendingQueueReferenceSchema).max(50).default([]) }).strict()
const desktopPendingQueueItemSchema = pendingQueueItemSchema.extend({
  modelId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u).optional(),
  references: z.array(z.union([
    pendingQueueReferenceSchema,
    z.object({ type: z.literal('file'), id: z.string().regex(/^path-[A-Za-z0-9_-]{1,23995}$/u),
      label: z.string().max(512) }).strict(),
  ])).max(50).default([]),
})


export function mergePendingQueueItems(existing: unknown, incoming: Item[], removed: number[]): Item[] {
  const byKey = new Map<unknown, Item>()
  for (const item of Array.isArray(existing) ? existing : []) if (item && typeof item === 'object' && !Array.isArray(item)) byKey.set(item.key, item)
  for (const key of removed) byKey.delete(key)
  for (const item of incoming) byKey.set(item.key, { ...byKey.get(item.key), ...item })
  return [...byKey.values()]
}
export function visiblePendingQueueItems(queueId: string, sessionId: number | null, items: unknown, now: number, trustedProjection = false) {
  return (Array.isArray(items) ? items : []).flatMap((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const { _claim_token: token, _claim_until: until, claimed, ...visible } = item as Item
    return [{ ...visible, queue_id: queueId, session_id: sessionId, claimed: trustedProjection ? claimed === true : Boolean(token && typeof until === 'number' && until > now) }]
  })
}
function matches(stored: unknown, token: string) {
  if (typeof stored !== 'string') return false
  const left = Buffer.from(stored), right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** 调用方必须使用受控 SQLite 单写入连接；事务在任何读取之前获取写锁。 */
export function createSqlAgentPendingQueue(db: Db, dialect: 'postgres' | 'sqlite', options: {
  isSessionActive?(sessionId: number, tx: Transaction<any>): Promise<boolean>; nowSeconds?: () => number; createToken?: () => string; clock?: () => string
}) {
  const now = options.nowSeconds ?? (() => Date.now() / 1000), token = options.createToken ?? (() => randomBytes(32).toString('base64url'))
  const ownerKey = (owner: string) => { const id = dataContext(owner).ownerId; return dialect === 'sqlite' ? id.replaceAll('-', '') : id }
  const validQueue = (id: string) => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new TypeError('队列标识无效') }
  const validSession = (id: number) => { if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('会话身份无效') }
  const validItems = (items: Item[]): Item[] => { const result = z.array(dialect === 'sqlite' ? desktopPendingQueueItemSchema : pendingQueueItemSchema).max(200).safeParse(items); if (!result.success) throw new TypeError('队列项目无效'); return result.data }
  const decode = (value: unknown): unknown => {
    if (dialect !== 'sqlite' || typeof value !== 'string') return value
    try { return JSON.parse(value) }
    catch (error) {
      if (error instanceof SyntaxError) throw new CoreError('storage_error', '队列数据格式无效')
      throw error
    }
  }
  const row = (value: { session_id: number | null; items: unknown } | undefined): Row | null => value ? { sessionId: value.session_id, items: decode(value.items) } : null
  async function transaction<T>(owner: string, queueId: string, work: (tx: Transaction<any>) => Promise<T>, session?: number): Promise<T> {
    validQueue(queueId)
    if (session !== undefined) validSession(session)
    return db.transaction().execute(async tx => {
      if (dialect === 'postgres' && session !== undefined) await sql`SELECT id FROM conversation_sessions WHERE id=${session} AND user_id=${owner} FOR UPDATE`.execute(tx)
      if (dialect === 'postgres') await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([owner, queueId])}, 0))`.execute(tx)
      else await sql`UPDATE conversation_pending_queues SET items=items WHERE user_id=${owner} AND queue_id=${queueId}`.execute(tx)
      return work(tx)
    })
  }
  async function owned(tx: Transaction<any>, owner: string, session: number, queueId: string) {
    const suffix = dialect === 'postgres' ? sql` FOR UPDATE` : sql``
    const found = await sql`SELECT id FROM conversation_sessions WHERE id=${session} AND user_id=${owner}${suffix}`.execute(tx)
    if (!found.rows.length) throw new QueueSessionNotFound()
    if (queueId !== `session-${session}`) throw new QueueConflict()
  }
  async function read(tx: Db | Transaction<any>, owner: string, queueId: string, lock = false): Promise<Row | null> {
    const suffix = lock && dialect === 'postgres' ? sql` FOR UPDATE` : sql``
    const result = await sql<{ session_id: number | null; items: unknown }>`SELECT session_id,items FROM conversation_pending_queues WHERE user_id=${owner} AND queue_id=${queueId}${suffix}`.execute(tx)
    return row(result.rows[0])
  }
  async function write(tx: Transaction<any>, owner: string, queueId: string, session: number | null, items: Item[]) {
    if (!items.length) { await sql`DELETE FROM conversation_pending_queues WHERE user_id=${owner} AND queue_id=${queueId}`.execute(tx); return }
    const data = JSON.stringify(items), value = dialect === 'postgres' ? sql`${data}::jsonb` : sql`${data}`
    const timestamp = dialect === 'postgres' ? sql`CURRENT_TIMESTAMP` : sql`${databaseTime((options.clock ?? nowUtc)(), 'sqlite')}`
    await sql`INSERT INTO conversation_pending_queues(user_id,queue_id,session_id,items,updated_at) VALUES (${owner},${queueId},${session},${value},${timestamp})
      ON CONFLICT(user_id,queue_id) DO UPDATE SET session_id=excluded.session_id,items=excluded.items,updated_at=excluded.updated_at`.execute(tx)
  }
  return {
    async consumeClaim(tx: Transaction<any>, ownerId: string, session: number, key: number, claimToken: string) {
      const owner = ownerKey(ownerId), queueId = `session-${session}`
      await owned(tx, owner, session, queueId)
      const current = await read(tx, owner, queueId, true)
      const items = current?.sessionId === session && Array.isArray(current.items) ? current.items as Item[] : []
      const index = items.findIndex(item => item?.key === key && matches(item._claim_token, claimToken))
      if (index < 0) throw new CoreError('conflict', '待发送队列认领冲突')
      await write(tx, owner, queueId, session, items.filter((_, position) => position !== index))
    },
    readQueue: async (owner: string, queueId: string) => {
      validQueue(queueId)
      const current = await read(db, ownerKey(owner), queueId)
      return current ? { sessionId: current.sessionId, items: visiblePendingQueueItems(queueId, current.sessionId, current.items, now()), projected: true as const } : null
    },
    async readImportedDrafts(owner: string) {
      owner = ownerKey(owner)
      const result = await sql<{ queue_id: string; items: unknown }>`SELECT queue_id,items FROM conversation_pending_queues WHERE user_id=${owner} AND session_id IS NULL AND queue_id LIKE 'import-%' ORDER BY updated_at,queue_id`.execute(db)
      const time = now()
      return result.rows.map(item => ({ queueId: item.queue_id, items: visiblePendingQueueItems(item.queue_id, null, decode(item.items), time), projected: true as const }))
    },
    replaceDraft: (owner: string, queueId: string, items: Item[]) => { owner = ownerKey(owner); items = validItems(items); if (queueId.startsWith('session-')) throw new QueueConflict(); return transaction(owner, queueId, async tx => {
      if ((await read(tx, owner, queueId, true))?.sessionId != null) throw new QueueConflict()
      await write(tx, owner, queueId, null, items)
    }) },
    patch: (owner: string, queueId: string, session: number, items: Item[], removed: number[]) => { owner = ownerKey(owner); items = validItems(items); if (!Array.isArray(removed) || removed.length > 200 || removed.some(key => !Number.isSafeInteger(key))) throw new TypeError('队列项目无效'); return transaction(owner, queueId, async tx => {
      await owned(tx, owner, session, queueId)
      const current = await read(tx, owner, queueId, true)
      if (!current && !items.length) return
      await write(tx, owner, queueId, session, mergePendingQueueItems(current?.items, items, removed))
    }, session) },
    claim: async (owner: string, session: number, queueId: string, key: number) => { owner = ownerKey(owner); if (!Number.isSafeInteger(key) || key < 1) throw new TypeError('队列项目无效'); return transaction(owner, queueId, async tx => {
      await owned(tx, owner, session, queueId)
      if (!options.isSessionActive) throw new Error('会话运行状态服务不可用')
      if (await options.isSessionActive(session, tx)) return { claimToken: null, reason: 'session_active' as const }
      const current = await read(tx, owner, queueId, true), items = current?.sessionId === session && Array.isArray(current.items) ? current.items as Item[] : []
      const item = items.find(value => value && typeof value === 'object' && value.key === key)
      const time = now()
      if (!item || item._claim_token && typeof item._claim_until === 'number' && item._claim_until > time) return { claimToken: null }
      const claimToken = token()
      await write(tx, owner, queueId, session, items.map(value => value === item ? { ...item, _claim_token: claimToken, _claim_until: time + 60 } : value))
      return { claimToken }
    }, session) },
    release: (owner: string, session: number, queueId: string, key: number, claimToken: string) => { owner = ownerKey(owner); if (!Number.isSafeInteger(key) || key < 1 || typeof claimToken !== 'string' || !claimToken || claimToken.length > 128) throw new TypeError('认领参数无效'); return transaction(owner, queueId, async tx => {
      await owned(tx, owner, session, queueId)
      const current = await read(tx, owner, queueId, true), items = current?.sessionId === session && Array.isArray(current.items) ? current.items as Item[] : []
      const index = items.findIndex(value => value && typeof value === 'object' && value.key === key && matches(value._claim_token, claimToken))
      if (index < 0) return false
      const updated = [...items], { _claim_token: _token, _claim_until: _until, ...visible } = updated[index]!
      updated[index] = visible
      await write(tx, owner, queueId, session, updated)
      return true
    }, session) },
  }
}

/** 不拥有连接池生命周期，由 Host 关闭共享池。 */
export function createPostgresAgentPendingQueue(pool: Pick<Pool, 'query' | 'connect'>, options: Parameters<typeof createSqlAgentPendingQueue>[2]) {
  return createSqlAgentPendingQueue(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }), 'postgres', options)
}
