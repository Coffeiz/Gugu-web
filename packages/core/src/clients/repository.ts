import { sql } from 'kysely'
import type { Insertable, Kysely, Transaction } from 'kysely'
import type { ClientRecord, Fields } from '../contracts/index.js'
import { clientRecord, databaseTime, type Clock } from '../data/codec.js'
import type { ClientTable, Database } from '../data/schema.js'
import type { Backend } from '../data/repositories.js'
import type { ClientRepository } from './service.js'

type Session = Kysely<Database> | Transaction<Database>
export class SqlClientRepository implements ClientRepository {
  constructor(
    private db: Session,
    private owner: string,
    private backend: Backend,
    private clock: Clock,
  ) {}
  private ownedQuery() {
    return this.db.selectFrom('clients').selectAll().where('user_id', '=', this.owner)
  }
  async list(): Promise<ClientRecord[]> {
    return (await this.ownedQuery().orderBy('created_at', 'desc').orderBy('id', 'desc').execute()).map(clientRecord)
  }
  /** 与 Python SQL 仓储一致：owner 内精确优先，再交给对应数据库执行模糊匹配。 */
  async findByName(name: string): Promise<ClientRecord[]> {
    const query = this.ownedQuery()
    const exact = await query.where('name', '=', name).execute()
    if (exact.length) return exact.map(row => clientRecord(row))
    const pattern = `%${name}%`
    const rows = this.backend === 'postgres'
      ? await query.where('name', 'ilike', pattern).execute()
      : await query.where(sql<boolean>`lower(${sql.ref('name')}) LIKE lower(${pattern})`).execute()
    return rows.map(row => clientRecord(row))
  }
  async get(id: number): Promise<ClientRecord | null> {
    const row = await this.ownedQuery().where('id', '=', id).executeTakeFirst()
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
