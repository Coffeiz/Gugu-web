import { Kysely, sql } from 'kysely'
import type { Insertable, Transaction, Updateable } from 'kysely'
import { createHash } from 'node:crypto'
import { CoreError, dataContext, operationSchema } from '../contracts/index.js'
import type { ClientRecord, DataContext, Fields, ProjectRecord } from '../contracts/index.js'
import { ProjectService, ClientService } from '../application/services.js'
import type { ClientRepository, DataServices, ProjectRepository } from '../application/services.js'
import { DEFAULT_PROJECT_COLOR } from '../domain/colors.js'
import { clientRecord, databaseTime, integer, nowUtc, projectRecord } from './codec.js'
import type { Clock } from './codec.js'
import type { ClientTable, Database, ProjectTable } from './schema.js'

type Session = Kysely<Database> | Transaction<Database>
export type Backend = 'sqlite' | 'postgres'
export class SqlProjectRepository implements ProjectRepository {
  constructor(private db: Session, private owner: string, private backend: Backend, private clock: Clock) {}
  async list(archived = false): Promise<ProjectRecord[]> {
    const rows = await this.db.selectFrom('projects').selectAll().where('user_id', '=', this.owner).where('deleted_at', 'is', null)
      .where('archived', '=', this.backend === 'sqlite' ? Number(archived) : archived).orderBy('created_at', 'desc').orderBy('id', 'desc').execute()
    return rows.map(row => projectRecord(row as unknown as Record<string, unknown>))
  }
  async get(id: number): Promise<ProjectRecord | null> {
    const row = await this.db.selectFrom('projects').selectAll().where('id', '=', id).where('user_id', '=', this.owner).where('deleted_at', 'is', null).executeTakeFirst()
    return row ? projectRecord(row as unknown as Record<string, unknown>) : null
  }
  async create(values: Fields): Promise<ProjectRecord> {
    const time = databaseTime(this.clock(), this.backend)
    const { client, ...rest } = values
    const inserted: Insertable<ProjectTable> = {
      name: '', summary: null, contact_name: null, status: 'pending', start_date: null, deadline: null,
      color: DEFAULT_PROJECT_COLOR, progress: 0, stages_json: '[]', current_stage: null, priority: null, version: 1,
      archived: this.backend === 'sqlite' ? 0 : false, done_at: null, created_at: time, updated_at: time, deleted_at: null,
      idempotency_key: null, idempotency_fingerprint: null, ...rest, user_id: this.owner,
    }
    if (client !== undefined) inserted.contact_name = client as string | null
    if (this.backend === 'sqlite') inserted.archived = Number(inserted.archived)
    const row = await this.db.insertInto('projects').values(inserted).returningAll().executeTakeFirstOrThrow()
    return projectRecord(row as unknown as Record<string, unknown>)
  }
  async update(id: number, version: number, values: Fields): Promise<boolean> {
    const { client, ...rest } = values
    const changed: Updateable<ProjectTable> = { ...rest, updated_at: databaseTime(this.clock(), this.backend) }
    if (client !== undefined) changed.contact_name = client as string | null
    if ('archived' in values) changed.archived = this.backend === 'sqlite' ? Number(values.archived) : values.archived as boolean
    const done = 'status' in values ? { done_at: values.status === 'done' ? sql<string>`coalesce(done_at, ${changed.updated_at})` : null } : {}
    const result = await this.db.updateTable('projects').set({ ...changed, ...done, version: sql<number>`version + 1` }).where('id', '=', id).where('user_id', '=', this.owner)
      .where('deleted_at', 'is', null).where('version', '=', version).executeTakeFirst()
    return result.numUpdatedRows === 1n
  }
}
export class SqlClientRepository implements ClientRepository {
  constructor(private db: Session, private owner: string, private backend: Backend, private clock: Clock) {}
  async list(): Promise<ClientRecord[]> { return (await this.db.selectFrom('clients').selectAll().where('user_id', '=', this.owner).orderBy('created_at', 'desc').orderBy('id', 'desc').execute()).map(row => clientRecord(row as unknown as Record<string, unknown>)) }
  async get(id: number): Promise<ClientRecord | null> { const row = await this.db.selectFrom('clients').selectAll().where('id', '=', id).where('user_id', '=', this.owner).executeTakeFirst(); return row ? clientRecord(row as unknown as Record<string, unknown>) : null }
  async create(values: Fields): Promise<ClientRecord> {
    const inserted: Insertable<ClientTable> = { name: '', contact: null, email: null, phone: null, notes: '', ...values, user_id: this.owner, created_at: databaseTime(this.clock(), this.backend) }
    return clientRecord(await this.db.insertInto('clients').values(inserted).returningAll().executeTakeFirstOrThrow() as unknown as Record<string, unknown>)
  }
  async update(id: number, values: Fields): Promise<boolean> { const result = await this.db.updateTable('clients').set(values).where('id', '=', id).where('user_id', '=', this.owner).executeTakeFirst(); return result.numUpdatedRows === 1n }
  async delete(id: number): Promise<boolean> { const result = await this.db.deleteFrom('clients').where('id', '=', id).where('user_id', '=', this.owner).executeTakeFirst(); return result.numDeletedRows === 1n }
}
function services(session: Session, owner: string, backend: Backend, clock: Clock): DataServices {
  return { projects: new ProjectService(new SqlProjectRepository(session, owner, backend, clock)), clients: new ClientService(new SqlClientRepository(session, owner, backend, clock)) }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Fields)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export class SqlDataRuntime {
  private closed = false
  constructor(readonly db: Kysely<Database>, readonly backend: Backend, private clock: Clock = nowUtc, readonly receipts = true, private disposeUnused?: () => void) {}
  private owner(context: DataContext): string { const id = dataContext(context.ownerId).ownerId; return this.backend === 'sqlite' ? id.replaceAll('-', '') : id }
  private check(signal?: Pick<AbortSignal, 'aborted'>): void {
    if (this.closed) throw new CoreError('closed', '数据运行时已关闭')
    if (signal?.aborted) throw new CoreError('cancelled', '操作已取消')
  }
  async transaction<T>(context: DataContext, work: (data: DataServices) => Promise<T>, options: { signal?: Pick<AbortSignal, 'aborted'> } = {}): Promise<T> {
    this.check(options.signal); const owner = this.owner(context)
    return this.db.transaction().execute(async tx => { this.check(options.signal); const result = await work(services(tx, owner, this.backend, this.clock)); this.check(options.signal); return result })
  }
  async operation<T>(context: DataContext, operationId: string, method: string, params: Fields, work: (data: DataServices) => Promise<T>, options: { signal?: Pick<AbortSignal, 'aborted'> } = {}): Promise<T> {
    this.check(options.signal)
    if (!this.receipts) throw new CoreError('schema_upgrade_required', '此数据库需要显式升级后才能记录操作收据')
    if (!operationSchema.safeParse(operationId).success) throw new CoreError('invalid_request', '操作标识无效')
    const owner = this.owner(context), fingerprint = createHash('sha256').update(canonical({ method, params })).digest('hex')
    return this.db.transaction().execute(async tx => {
      // PG 的事务级锁只串行化同一用户的同一操作标识；SQLite 由单 Worker 顺序执行。
      if (this.backend === 'postgres') await sql`select pg_advisory_xact_lock(hashtextextended(${`${owner}:${operationId}`}, 0))`.execute(tx)
      this.check(options.signal)
      const previous = await tx.selectFrom('core_operation_receipts').selectAll().where('owner_id', '=', owner).where('operation_id', '=', operationId).executeTakeFirst()
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new CoreError('conflict', '操作标识已用于不同内容')
        return JSON.parse(previous.result_json) as T
      }
      const result = await work(services(tx, owner, this.backend, this.clock))
      this.check(options.signal)
      await tx.insertInto('core_operation_receipts').values({ owner_id: owner, operation_id: operationId, fingerprint, method, result_json: JSON.stringify(result), created_at: databaseTime(this.clock(), this.backend) }).execute()
      this.check(options.signal)
      return result
    })
  }
  async receipt(context: DataContext, operationId: string): Promise<{ method: string; result: unknown } | null> {
    this.check()
    if (!operationSchema.safeParse(operationId).success) throw new CoreError('invalid_request', '操作标识无效')
    if (!this.receipts) throw new CoreError('schema_upgrade_required', '此数据库需要显式升级后才能读取操作收据')
    const row = await this.db.selectFrom('core_operation_receipts').select(['method', 'result_json']).where('owner_id', '=', this.owner(context)).where('operation_id', '=', operationId).executeTakeFirst()
    return row ? { method: row.method, result: JSON.parse(row.result_json) } : null
  }
  async close(): Promise<void> { this.closed = true; try { await this.db.destroy() } finally { this.disposeUnused?.() } }
}
