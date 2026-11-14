import { sql } from 'kysely'
import type { Insertable, Kysely, Selectable, SelectQueryBuilder, Transaction, Updateable } from 'kysely'
import type { ClientRecord, Fields, ProjectRecord } from '../contracts/index.js'
import { ProjectService, ClientService } from '../application/services.js'
import type { ClientRepository, DataServices, ProjectRepository } from '../application/services.js'
import { DEFAULT_PROJECT_COLOR } from '../domain/colors.js'
import { clientRecord, databaseTime, projectRecord } from './codec.js'
import type { Clock } from './codec.js'
import type { ClientTable, Database, ProjectTable } from './schema.js'

type Session = Kysely<Database> | Transaction<Database>
export type Backend = 'sqlite' | 'postgres'
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
  async listDeleted(since: string): Promise<ProjectRecord[]> {
    const cutoff = databaseTime(since, this.backend)
    return this.listRows(
      this.projectRows()
        .where('deleted_at', 'is not', null)
        .where('deleted_at', '>=', cutoff),
      'deleted_at',
    )
  }
  async get(id: number): Promise<ProjectRecord | null> {
    const row = await this.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', this.owner)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
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
export class SqlClientRepository implements ClientRepository {
  constructor(
    private db: Session,
    private owner: string,
    private backend: Backend,
    private clock: Clock,
  ) {}
  async list(): Promise<ClientRecord[]> {
    return (
      await this.db
        .selectFrom('clients')
        .selectAll()
        .where('user_id', '=', this.owner)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute()
    ).map((row) => clientRecord(row))
  }
  async get(id: number): Promise<ClientRecord | null> {
    const row = await this.db
      .selectFrom('clients')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', this.owner)
      .executeTakeFirst()
    return row ? clientRecord(row) : null
  }
  async create(values: Fields): Promise<ClientRecord> {
    const inserted: Insertable<ClientTable> = {
      name: '',
      contact: null,
      email: null,
      phone: null,
      notes: '',
      ...values,
      user_id: this.owner,
      created_at: databaseTime(this.clock(), this.backend),
    }
    return clientRecord(
      await this.db.insertInto('clients').values(inserted).returningAll().executeTakeFirstOrThrow(),
    )
  }
  async update(id: number, values: Fields): Promise<boolean> {
    const result = await this.db
      .updateTable('clients')
      .set(values)
      .where('id', '=', id)
      .where('user_id', '=', this.owner)
      .executeTakeFirst()
    return result.numUpdatedRows === 1n
  }
  async delete(id: number): Promise<boolean> {
    const result = await this.db
      .deleteFrom('clients')
      .where('id', '=', id)
      .where('user_id', '=', this.owner)
      .executeTakeFirst()
    return result.numDeletedRows === 1n
  }
}
export function services(
  session: Session,
  owner: string,
  backend: Backend,
  clock: Clock,
): DataServices {
  return {
    projects: new ProjectService(new SqlProjectRepository(session, owner, backend, clock)),
    clients: new ClientService(new SqlClientRepository(session, owner, backend, clock)),
  }
}
