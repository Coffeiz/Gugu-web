import { Kysely, sql } from 'kysely'
import { createHash } from 'node:crypto'
import { CoreError, dataContext, operationSchema } from '../contracts/index.js'
import type { DataContext, Fields } from '../contracts/index.js'
import type { DataServices } from '../application/services.js'
import { databaseTime, nowUtc } from './codec.js'
import type { Clock } from './codec.js'
import type { Database } from './schema.js'
import { services } from './repositories.js'
import type { Backend } from './repositories.js'

// 保留现有数据入口，仓储实现与事务/收据生命周期分别维护。
export { SqlProjectRepository, SqlClientRepository } from './repositories.js'
export type { Backend } from './repositories.js'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Fields)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export class SqlDataRuntime {
  private closed = false
  constructor(
    readonly db: Kysely<Database>,
    readonly backend: Backend,
    private clock: Clock = nowUtc,
    readonly receipts = true,
    private disposeUnused?: () => void,
  ) {}
  private owner(context: DataContext): string {
    const id = dataContext(context.ownerId).ownerId
    return this.backend === 'sqlite' ? id.replaceAll('-', '') : id
  }
  private check(signal?: Pick<AbortSignal, 'aborted'>): void {
    if (this.closed) throw new CoreError('closed', '数据运行时已关闭')
    if (signal?.aborted) throw new CoreError('cancelled', '操作已取消')
  }
  async transaction<T>(
    context: DataContext,
    work: (data: DataServices) => Promise<T>,
    options: { signal?: Pick<AbortSignal, 'aborted'> } = {},
  ): Promise<T> {
    this.check(options.signal)
    const owner = this.owner(context)
    return this.db.transaction().execute(async (tx) => {
      this.check(options.signal)
      const result = await work(services(tx, owner, this.backend, this.clock))
      this.check(options.signal)
      return result
    })
  }
  async operation<T>(
    context: DataContext,
    operationId: string,
    method: string,
    params: Fields,
    work: (data: DataServices) => Promise<T>,
    options: { signal?: Pick<AbortSignal, 'aborted'> } = {},
  ): Promise<T> {
    this.check(options.signal)
    if (!this.receipts)
      throw new CoreError('schema_upgrade_required', '此数据库需要显式升级后才能记录操作收据')
    if (!operationSchema.safeParse(operationId).success)
      throw new CoreError('invalid_request', '操作标识无效')
    const owner = this.owner(context),
      fingerprint = createHash('sha256').update(canonical({ method, params })).digest('hex')
    return this.db.transaction().execute(async (tx) => {
      // PG 的事务级锁只串行化同一用户的同一操作标识；SQLite 由单 Worker 顺序执行。
      if (this.backend === 'postgres')
        await sql`select pg_advisory_xact_lock(hashtextextended(${`${owner}:${operationId}`}, 0))`.execute(
          tx,
        )
      this.check(options.signal)
      const previous = await tx
        .selectFrom('core_operation_receipts')
        .selectAll()
        .where('owner_id', '=', owner)
        .where('operation_id', '=', operationId)
        .executeTakeFirst()
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new CoreError('conflict', '操作标识已用于不同内容')
        return JSON.parse(previous.result_json) as T
      }
      const result = await work(services(tx, owner, this.backend, this.clock))
      this.check(options.signal)
      await tx
        .insertInto('core_operation_receipts')
        .values({
          owner_id: owner,
          operation_id: operationId,
          fingerprint,
          method,
          result_json: JSON.stringify(result),
          created_at: databaseTime(this.clock(), this.backend),
        })
        .execute()
      this.check(options.signal)
      return result
    })
  }
  async receipt(
    context: DataContext,
    operationId: string,
  ): Promise<{ method: string; result: unknown } | null> {
    this.check()
    if (!operationSchema.safeParse(operationId).success)
      throw new CoreError('invalid_request', '操作标识无效')
    if (!this.receipts)
      throw new CoreError('schema_upgrade_required', '此数据库需要显式升级后才能读取操作收据')
    const row = await this.db
      .selectFrom('core_operation_receipts')
      .select(['method', 'result_json'])
      .where('owner_id', '=', this.owner(context))
      .where('operation_id', '=', operationId)
      .executeTakeFirst()
    return row ? { method: row.method, result: JSON.parse(row.result_json) } : null
  }
  async close(): Promise<void> {
    this.closed = true
    try {
      await this.db.destroy()
    } finally {
      this.disposeUnused?.()
    }
  }
}
