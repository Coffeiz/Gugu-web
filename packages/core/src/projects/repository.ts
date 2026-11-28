import { sql } from 'kysely'
import type { Insertable, Kysely, Selectable, SelectQueryBuilder, Transaction, Updateable } from 'kysely'
import type { Fields, ProjectRecord } from '../contracts/index.js'
import { DEFAULT_PROJECT_COLOR } from './colors.js'
import { databaseTime, projectRecord, type Clock } from '../data/codec.js'
import type { Database, ProjectTable } from '../data/schema.js'
import type { Backend } from '../data/repositories.js'
import type { ProjectRepository } from './service.js'

type Session = Kysely<Database> | Transaction<Database>
export class SqlProjectRepository implements ProjectRepository {
  constructor(
    private db: Session,
    private owner: string,
    private backend: Backend,
    private clock: Clock,
  ) {}
  private projectRows() {
    return this.db
      .selectFrom('projects')
      .selectAll()
      .where('user_id', '=', this.owner)
  }
  private async listRows(
    query: SelectQueryBuilder<Database, 'projects', Selectable<ProjectTable>>,
    orderBy: 'created_at' | 'deleted_at' = 'created_at',
  ): Promise<ProjectRecord[]> {
    const rows = await query.orderBy(orderBy, 'desc').orderBy('id', 'desc').execute()
    return rows.map((row) => projectRecord(row))
  }
  async list(archived = false): Promise<ProjectRecord[]> {
    return this.listRows(
      this.projectRows()
        .where('deleted_at', 'is', null)
        .where('archived', '=', this.backend === 'sqlite' ? Number(archived) : archived),
    )
  }
  /** Python 项目查询契约：owner内存活项目精确优先，包含归档并保留数据库结果顺序。 */
  async findByName(name: string): Promise<ProjectRecord[]> {
    const query = this.projectRows().where('deleted_at', 'is', null)
    const exact = await query.where('name', '=', name).execute()
    if (exact.length) return exact.map(row => projectRecord(row))
    const pattern = `%${name}%`
    const rows = this.backend === 'postgres'
      ? await query.where('name', 'ilike', pattern).execute()
      : await query.where(sql<boolean>`lower(${sql.ref('name')}) LIKE lower(${pattern})`).execute()
    return rows.map(row => projectRecord(row))
  }
  async listDeleted(since: string): Promise<ProjectRecord[]> {
    const cutoff = databaseTime(since, this.backend)
    return this.listRows(
      this.projectRows()
        .where('deleted_at', 'is not', null)
        .where('deleted_at', '>=', cutoff),
      'deleted_at',
    )
  }
  async get(id: number, includeDeleted = false): Promise<ProjectRecord | null> {
    let query = this.db.selectFrom('projects').selectAll().where('id', '=', id).where('user_id', '=', this.owner)
    if (!includeDeleted) query = query.where('deleted_at', 'is', null)
    const row = await query.executeTakeFirst()
    return row ? projectRecord(row) : null
  }
  async create(values: Fields): Promise<ProjectRecord> {
    const time = databaseTime(this.clock(), this.backend)
    const { client, ...rest } = values
    const inserted: Insertable<ProjectTable> = {
      name: '',
      summary: null,
      contact_name: null,
      status: 'pending',
      start_date: null,
      deadline: null,
      color: DEFAULT_PROJECT_COLOR,
      progress: 0,
      stages_json: '[]',
      current_stage: null,
      priority: null,
      version: 1,
      archived: this.backend === 'sqlite' ? 0 : false,
      done_at: null,
      created_at: time,
      updated_at: time,
      deleted_at: null,
      idempotency_key: null,
      idempotency_fingerprint: null,
      ...rest,
      user_id: this.owner,
    }
    if (client !== undefined) inserted.contact_name = client as string | null
    if (this.backend === 'sqlite') inserted.archived = Number(inserted.archived)
    const row = await this.db
      .insertInto('projects')
      .values(inserted)
      .returningAll()
      .executeTakeFirstOrThrow()
    return projectRecord(row)
  }
  async update(id: number, version: number, values: Fields): Promise<boolean> {
    const { client, ...rest } = values
    const changed: Updateable<ProjectTable> = {
      ...rest,
      updated_at: databaseTime(this.clock(), this.backend),
    }
    if (client !== undefined) changed.contact_name = client as string | null
    if ('archived' in values)
      changed.archived =
        this.backend === 'sqlite' ? Number(values.archived) : (values.archived as boolean)
    const done =
      'status' in values
        ? {
            done_at:
              values.status === 'done'
                ? sql<string>`coalesce(done_at, ${changed.updated_at})`
                : null,
          }
        : {}
    const result = await this.db
      .updateTable('projects')
      .set({ ...changed, ...done, version: sql<number>`version + 1` })
      .where('id', '=', id)
      .where('user_id', '=', this.owner)
      .where('deleted_at', 'is', null)
      .where('version', '=', version)
      .executeTakeFirst()
    return result.numUpdatedRows === 1n
  }
}
