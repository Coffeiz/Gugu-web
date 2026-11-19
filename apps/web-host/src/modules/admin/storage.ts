import { statfsSync } from 'node:fs'

import type { Pool } from 'pg'

import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { resolve } from 'node:path'

import { adminHttpError } from './errors.js'

import { createRedisScheduledTaskCommands,createRedisValueReader } from '../../adapters/redis-events.js'

import { randomUUID } from 'node:crypto'

export interface AdminStorageSnapshotRow {
  category: string
  taken_at: Date | string
  object_count: number | string | bigint
  total_bytes: number | string | bigint
}

export type AdminStorageSnapshotQuery = (
  sql: string,
  values: unknown[],
) => Promise<AdminStorageSnapshotRow[]>

export interface AdminStorageSnapshotOptions {
  requireAdmin: preHandlerHookHandler
  query: AdminStorageSnapshotQuery
  diskUsage(): Promise<StorageDiskUsage | null> | StorageDiskUsage | null
  now?: () => Date | string
}

export interface StorageDiskUsage {
  total_bytes: number | bigint
  used_bytes: number | bigint
  free_bytes: number | bigint
}

export interface StorageLocation {
  localPath: string
}

export const STORAGE_SNAPSHOTS_SQL = `
SELECT category,
       to_char(taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS taken_at,
       object_count,
       total_bytes
FROM storage_category_snapshots
WHERE taken_at >= $1::timestamptz
ORDER BY taken_at ASC
`

export function createPostgresAdminStorageSnapshotQuery(pool: Pick<Pool, 'query'>): AdminStorageSnapshotQuery {
  return async (sql, values) => (await pool.query(sql, values as never[])).rows as AdminStorageSnapshotRow[]
}

/** 与 Python shutil.disk_usage 一样区分实际已用和调用者可用空间。 */
export function diskUsageForStorage(storage: StorageLocation): StorageDiskUsage | null {
  try {
    const stats = statfsSync(resolve(storage.localPath), { bigint: true })
    return {
      total_bytes: stats.bsize * stats.blocks,
      used_bytes: (stats.blocks - stats.bfree) * stats.bsize,
      free_bytes: stats.bavail * stats.bsize,
    }
  } catch {
    return null
  }
}

function isoUtc(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('invalid timestamp')
    return value.toISOString()
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(value)
  if (match) {
    const fraction = match[2]
    return `${match[1]}${fraction && !/^0+$/.test(fraction) ? `.${fraction.padEnd(6, '0')}` : ''}Z`
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('invalid timestamp')
  return date.toISOString()
}

function integerValue(value: number | string | bigint): number | bigint {
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('invalid integer')
    return value
  }
  if (!/^-?\d+$/.test(value)) throw new Error('invalid integer')
  const parsed = BigInt(value)
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) && parsed >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(parsed)
    : parsed
}

function jsonWithBigInt(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('invalid JSON value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(jsonWithBigInt).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}:${jsonWithBigInt(item)}`).join(',')}}`
  }
  throw new Error('invalid JSON value')
}

function cutoffIso(value: Date | string, days: number): string {
  if (value instanceof Date) {
    const cutoff = new Date(value.getTime() - days * 86_400_000)
    if (Number.isNaN(cutoff.getTime())) throw new Error('invalid clock')
    return cutoff.toISOString()
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) {
    const cutoff = new Date(new Date(value).getTime() - days * 86_400_000)
    if (Number.isNaN(cutoff.getTime())) throw new Error('invalid clock')
    return cutoff.toISOString()
  }
  const wholeSecond = new Date(`${match[1]}${match[3] ?? 'Z'}`)
  if (Number.isNaN(wholeSecond.getTime())) throw new Error('invalid clock')
  const cutoffSecond = new Date(wholeSecond.getTime() - days * 86_400_000).toISOString().slice(0, 19)
  const fraction = match[2]?.padEnd(6, '0')
  return `${cutoffSecond}${fraction && /[1-9]/.test(fraction) ? `.${fraction}` : ''}Z`
}

export function registerAdminStorageSnapshotsRoute(app: FastifyInstance, options: AdminStorageSnapshotOptions): void {
  app.get<{ Querystring: { days?: number } }>(
    '/api/v1/admin/ops/storage-snapshots',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
        },
      },
    },
    async (request, reply) => {
      const days = request.query.days ?? 30
      let cutoff: string
      try {
        cutoff = cutoffIso(options.now?.() ?? new Date(), days)
        const rows = await options.query(STORAGE_SNAPSHOTS_SQL, [cutoff])
        const categories: Record<string, Array<{
          taken_at: string
          object_count: number | bigint
          total_bytes: number | bigint
        }>> = {}
        for (const row of rows) {
          if (typeof row.category !== 'string') throw new Error('invalid category')
          ;(categories[row.category] ??= []).push({
            taken_at: isoUtc(row.taken_at),
            object_count: integerValue(row.object_count),
            total_bytes: integerValue(row.total_bytes),
          })
        }
        let disk: StorageDiskUsage | null
        try { disk = await options.diskUsage() } catch { disk = null }
        return reply.type('application/json').send(jsonWithBigInt({ categories, disk }))
      } catch {
        throw adminHttpError(500, '服务器内部错误，请稍后重试')
      }
    },
  )
}

export function registerStorageLiveTotalsRoute(app: FastifyInstance, options: {
  requireAdmin: preHandlerHookHandler
  read(): Promise<{ categories: Record<string, { object_count: number; total_bytes: number }> }>
}): void {
  app.get('/api/v1/admin/ops/storage-live-totals', { preHandler: options.requireAdmin }, () => options.read())
}


const ttl=7*24*60*60
/** 与Python共用真实状态和锁；CAS同时复核状态版本与锁，避免并发终态丢失。 */
export function createRedisStorageQuotaStatusStore(redisUrl:string):StorageQuotaStatusStore {
 const reads=createRedisValueReader(redisUrl),commands=createRedisScheduledTaskCommands(redisUrl)
 return {
  read:()=>reads(storageQuotaStateKey),
  lockExists:async()=>Number(await commands.exists(storageQuotaLockKey))>0,
  interruptIfUnchanged:async(expected,next)=>Number(await commands.eval("if redis.call('GET',KEYS[1])==ARGV[1] and redis.call('EXISTS',KEYS[2])==0 then redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]);return 1 end;return 0",2,storageQuotaStateKey,storageQuotaLockKey,expected,next,String(ttl)))===1,
 }
}
export interface StorageQuotaManualStarter {start():Promise<{started:boolean;state:unknown}>;close?():Promise<void>}
export interface StorageQuotaStatusOptions {requireAdmin:preHandlerHookHandler;store:StorageQuotaStatusStore;reconcile?:StorageQuotaManualStarter}
export function registerStorageQuotaStatusRoute(app:FastifyInstance,options:StorageQuotaStatusOptions):void {
 app.get('/api/v1/admin/storage-quota/reconcile',{preHandler:options.requireAdmin},async(_request,reply)=>{try{return await readStorageQuotaStatus(options.store)}catch(error){if(error instanceof StorageQuotaStatusUnavailable)return reply.code(503).send({detail:error.message});throw error}})
 if(options.reconcile){
  app.post('/api/v1/admin/storage-quota/reconcile',{preHandler:options.requireAdmin},async(_request,reply)=>{
   try{return await options.reconcile!.start()}
   catch(error){if(error instanceof StorageQuotaReconcileUnavailable)return reply.code(503).send({detail:error.message});throw error}
  })
  if(options.reconcile.close)app.addHook('onClose',async()=>options.reconcile!.close!())
 }
}

export interface StorageTotalsRow { object_count: string | number; total_bytes: string | number }
export type StorageTotalsQuery = (text: string, params: unknown[]) => Promise<{ rows: StorageTotalsRow[] }>

/** 实时数据库占用；包含回收站文件，不依赖历史快照或文件系统扫描。 */
export function createStorageLiveTotals(query: StorageTotalsQuery) {
  return async () => {
    const categories: Record<string, { object_count: number; total_bytes: number }> = {}
    for (const [state, category] of [['draft','chat_staging_draft'],['attached','chat_staging_attached']] as const) {
      const result = await query('SELECT COUNT(id) AS object_count, COALESCE(SUM(size),0) AS total_bytes FROM chat_attachments WHERE state=$1', [state])
      const row = result.rows[0]!
      categories[category] = { object_count: Number(row.object_count), total_bytes: Number(row.total_bytes) }
    }
    const files = await query('SELECT COUNT(id) AS object_count, COALESCE(SUM(size_bytes),0) AS total_bytes FROM files', [])
    const row = files.rows[0]!
    categories.user_files = { object_count: Number(row.object_count), total_bytes: Number(row.total_bytes) }
    return { categories }
  }
}

export class StorageQuotaStatusUnavailable extends Error {readonly statusCode=503;constructor(){super('暂时无法读取对账状态');this.name='StorageQuotaStatusUnavailable'}}
export interface StorageQuotaStatusStore {
 read():Promise<string|null>
 lockExists():Promise<boolean>
 interruptIfUnchanged(expected:string,next:string):Promise<boolean>
}
function parse(raw:string|null):Record<string,unknown> {
 if(raw)try{const value:unknown=JSON.parse(raw);if(value&&typeof value==='object'&&!Array.isArray(value))return value as Record<string,unknown>}catch{/* Python损坏状态按idle处理。 */}
 return {status:'idle'}
}
/** 状态查询不会启动扫描；旧执行器的锁消失时才标记中断。 */
export async function readStorageQuotaStatus(store:StorageQuotaStatusStore,now:()=>string=()=>new Date().toISOString().replace(/\.000Z$/,'+00:00').replace(/(\.\d{3})Z$/,'$1000+00:00')):Promise<Record<string,unknown>> {
 try {
  const raw=await store.read(),state=parse(raw)
  if(raw && ['queued','running'].includes(String(state.status)) && !await store.lockExists()) {
   const interrupted={...state,status:'interrupted',finished_at:now()}
   if(await store.interruptIfUnchanged(raw,JSON.stringify(interrupted)))return interrupted
   // 并发完成或新执行获得锁时保留最新权威状态，避免读接口覆盖运行结果。
   return parse(await store.read())
  }
  return state
 }catch{throw new StorageQuotaStatusUnavailable()}
}

export class StorageQuotaScanBusy extends Error {
  readonly code = 'storage_quota_scan_busy'
  constructor() { super('存储容量校准繁忙，请稍后重试') }
}

export const UNLIMITED_STORAGE_BYTES = '9223372036854775807'

/** 用户 -1 表示不限额，null 继承系统默认，系统默认 null 也表示不限额。 */
export function resolveFileLibraryLimit(userLimit: string | number | null, defaultLimit: string | number | null): string {
  const normalize = (value: string | number): bigint => {
    const text = String(value)
    if (!/^-?\d+$/.test(text)) throw new RangeError('存储配额上限无效')
    const number = BigInt(text)
    if (number < -1n || number > BigInt(UNLIMITED_STORAGE_BYTES)) throw new RangeError('存储配额上限无效')
    return number
  }
  const user = userLimit === null ? null : normalize(userLimit)
  if (user === -1n) return UNLIMITED_STORAGE_BYTES
  if (user !== null) return String(user)
  const fallback = defaultLimit === null ? null : normalize(defaultLimit)
  if (fallback === null || fallback === -1n) return UNLIMITED_STORAGE_BYTES
  return String(fallback)
}

export interface StorageQuotaReconcileProgress {
  total: number
  processed: number
  completed: number
  failed: number
}

export interface StorageQuotaReconcilePort {
  /** 管理员手动全量校准包含全部用户，含停用用户。 */
  listUserIds(): Promise<readonly string[]>
  /** 完成扫描并以并发保护的事务应用账本修正。 */
  reconcileUser(userId: string, signal: AbortSignal): Promise<void>
}

export interface StorageQuotaReconcileOptions {
  concurrency?: number
  maxBusyAttempts?: number
  retryDelayMs?: number
  signal?: AbortSignal
  onProgress?(progress: StorageQuotaReconcileProgress): Promise<void> | void
  onUserError?(error: unknown): void
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** 限并发、逐用户隔离失败并发布兼容 Python 的人工全量校准进度。 */
export async function reconcileAllStorageUsers(
  port: StorageQuotaReconcilePort,
  options: StorageQuotaReconcileOptions = {},
): Promise<StorageQuotaReconcileProgress> {
  const concurrency = options.concurrency ?? 4
  const maxBusyAttempts = options.maxBusyAttempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 5_000
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32
    || !Number.isSafeInteger(maxBusyAttempts) || maxBusyAttempts < 1
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new RangeError('存储配额对账参数无效')
  const signal = options.signal ?? new AbortController().signal
  const userIds = await port.listUserIds()
  const progress: StorageQuotaReconcileProgress = { total: userIds.length, processed: 0, completed: 0, failed: 0 }
  const progressLock = { pending: Promise.resolve() }
  const report = async () => {
    if (!options.onProgress) return
    const snapshot = { ...progress }
    const next = progressLock.pending.then(() => options.onProgress!(snapshot))
    progressLock.pending = next.catch(() => undefined)
    await next
  }
  await report()
  let cursor = 0
  async function worker(): Promise<void> {
    while (!signal.aborted) {
      const index = cursor++
      if (index >= userIds.length) return
      const userId = userIds[index]!
      let succeeded = false
      for (let attempt = 1; attempt <= maxBusyAttempts && !signal.aborted; attempt += 1) {
        try {
          await port.reconcileUser(userId, signal)
          succeeded = true
          break
        } catch (error) {
          if (signal.aborted) return
          if (!(error instanceof StorageQuotaScanBusy) || attempt === maxBusyAttempts) {
            try { options.onUserError?.(error) } catch { /* 单用户诊断不得中断全量任务。 */ }
            break
          }
          await (options.wait ?? delay)(retryDelayMs, signal)
        }
      }
      if (signal.aborted) return
      progress.processed += 1
      if (succeeded) progress.completed += 1
      else progress.failed += 1
      await report()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, userIds.length || 1) }, worker))
  await progressLock.pending
  return { ...progress }
}

export const storageQuotaStateKey = 'storage:quota_reconcile:manual_state'
export const storageQuotaLockKey = 'storage:quota_reconcile:lock'
const stateTtlSeconds = 7 * 24 * 60 * 60
const lockTtlSeconds = 15 * 60
const lockRenewMs = 5 * 60 * 1000
const fencedWrite = "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]);return 1 end;return 0"
const renewLease = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],ARGV[2]) end;return 0"
const releaseLease = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end;return 0"

interface RedisCommands {
  set(key: string, value: string, ...options: string[]): Promise<unknown>
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
}

interface StateReader { read(): Promise<string | null> }
interface ManualState extends StorageQuotaReconcileProgress {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'busy'
  started_at: string | null
  updated_at?: string
  finished_at?: string
}

export class StorageQuotaReconcileUnavailable extends Error {
  constructor() { super('暂时无法启动对账') }
}

function stateFrom(raw: string | null): ManualState {
  if (!raw) return { status: 'idle' as ManualState['status'], total: 0, processed: 0, completed: 0, failed: 0, started_at: null }
  try {
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as ManualState
  } catch { /* 使用空闲态，与 Python 路由一致。 */ }
  return { status: 'idle' as ManualState['status'], total: 0, processed: 0, completed: 0, failed: 0, started_at: null }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, milliseconds)
    timer.unref?.()
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** 与 Python 共用 Redis 租约和状态协议；工作在 Host 生命周期内执行并有租约 fencing。 */
export function createManualStorageQuotaReconcile(options: {
  commands: RedisCommands
  state: StateReader
  work(signal: AbortSignal, progress: (value: StorageQuotaReconcileProgress) => Promise<void>): Promise<StorageQuotaReconcileProgress>
  now?(): string
  renewIntervalMs?: number
  onError?(error: unknown): void
}) {
  const now = options.now ?? (() => new Date().toISOString())
  const renewInterval = options.renewIntervalMs ?? lockRenewMs
  if (!Number.isSafeInteger(renewInterval) || renewInterval < 1) throw new RangeError('配额对账租约续期必须为正整数毫秒')
  let task: Promise<void> | null = null
  let active: AbortController | null = null
  let closing = false

  async function writeState(token: string, value: ManualState): Promise<boolean> {
    return String(await options.commands.eval(fencedWrite, 2, storageQuotaLockKey, storageQuotaStateKey,
      token, JSON.stringify(value), String(stateTtlSeconds))) === '1'
  }

  async function run(token: string, initial: ManualState, controller: AbortController): Promise<void> {
    let state = initial
    const renewController = new AbortController()
    const renewal = (async () => {
      while (!renewController.signal.aborted && !controller.signal.aborted) {
        await wait(renewInterval, renewController.signal)
        if (renewController.signal.aborted || controller.signal.aborted) return
        let renewed = false
        try { renewed = String(await options.commands.eval(renewLease, 1, storageQuotaLockKey, token, String(lockTtlSeconds))) === '1' }
        catch (error) { try { options.onError?.(error) } catch { /* diagnostics cannot interrupt lease fencing. */ } }
        if (!renewed) {
          controller.abort(new Error('配额对账租约已失效'))
          return
        }
      }
    })()
    try {
      state = { ...state, status: 'running', started_at: now() }
      if (!await writeState(token, state)) controller.abort(new Error('配额对账租约已失效'))
      const result = await options.work(controller.signal, async progress => {
        state = { ...state, ...progress, updated_at: now() }
        if (!await writeState(token, state)) controller.abort(new Error('配额对账租约已失效'))
      })
      state = { ...state, ...result, status: controller.signal.aborted ? 'interrupted' : 'completed', finished_at: now() }
    } catch (error) {
      try { options.onError?.(error) } catch { /* diagnostics cannot interrupt finalization. */ }
      state = { ...state, status: controller.signal.aborted ? 'interrupted' : 'failed', finished_at: now() }
    } finally {
      renewController.abort()
      await renewal
      try { await writeState(token, state) } catch (error) { try { options.onError?.(error) } catch { /* ignored */ } }
      try { await options.commands.eval(releaseLease, 1, storageQuotaLockKey, token) }
      catch (error) { try { options.onError?.(error) } catch { /* ignored */ } }
      if (active === controller) active = null
      task = null
    }
  }

  return {
    async start(): Promise<{ started: boolean; state: ManualState }> {
      if (closing) throw new StorageQuotaReconcileUnavailable()
      const token = randomUUID()
      let acquired: string | null
      try { acquired = await options.commands.set(storageQuotaLockKey, token, 'NX', 'EX', String(lockTtlSeconds)) as string | null }
      catch { throw new StorageQuotaReconcileUnavailable() }
      if (acquired !== 'OK') {
        try {
          const current = stateFrom(await options.state.read())
          return { started: false, state: current.status === 'queued' || current.status === 'running' ? current : { status: 'busy', total: 0, processed: 0, completed: 0, failed: 0, started_at: null } }
        } catch { throw new StorageQuotaReconcileUnavailable() }
      }
      const queued: ManualState = { status: 'queued', total: 0, processed: 0, completed: 0, failed: 0, started_at: null }
      try {
        if (!await writeState(token, queued)) throw new Error('配额对账租约已失效')
      } catch {
        try { await options.commands.eval(releaseLease, 1, storageQuotaLockKey, token) } catch { /* Preserve service-unavailable response. */ }
        throw new StorageQuotaReconcileUnavailable()
      }
      const controller = new AbortController()
      active = controller
      task = Promise.resolve().then(() => run(token, queued, controller))
      return { started: true, state: queued }
    },
    async close(): Promise<void> {
      closing = true
      active?.abort(new Error('Host 正在关闭'))
      await task
    },
  }
}
