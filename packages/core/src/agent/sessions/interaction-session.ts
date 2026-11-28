import { Kysely, PostgresDialect, sql } from 'kysely'
import type { Pool } from 'pg'
import { CoreError, dataContext } from '../../contracts/index.js'

export class InteractionNotFoundError extends Error {
  readonly statusCode = 404
  constructor() { super('交互不存在') }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function pythonTruthy(value: unknown): boolean {
  if (value == null || value === false || value === 0 || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  if (record(value)) return Object.keys(value).length > 0
  return true
}

/** 仅读取 prompt owner 与 ID；已解决/过期提示仍可定位，schema 不投影给调用方。 */
export function createSqlAgentInteractionSession(db: Kysely<any>, backend: 'postgres' | 'sqlite') {
  return async (ownerId: string, promptId: number): Promise<{ session_id: number }> => {
    const canonical = dataContext(ownerId).ownerId
    if (!Number.isSafeInteger(promptId)) throw new TypeError('交互 ID 无效')
    const owner = backend === 'sqlite' ? canonical.replaceAll('-', '') : canonical
    let row: { session_id: number; schema_json: unknown } | undefined
    try {
      const result = await sql<{ session_id: number; schema_json: unknown }>`SELECT session_id,schema_json FROM interaction_prompts WHERE id=${promptId} AND user_id=${owner}`.execute(db)
      row = result.rows[0]
    } catch (error) {
      const e = error as { code?: string; message?: string }
      if (backend === 'sqlite' && e.code === 'SQLITE_ERROR' && /no such table: interaction_prompts/.test(e.message ?? '')) throw new CoreError('schema_upgrade_required', '交互数据表尚未初始化')
      throw error
    }
    if (!row) throw new InteractionNotFoundError()
    let decoded = row.schema_json
    if (backend === 'sqlite' && typeof decoded === 'string') {
      try { decoded = JSON.parse(decoded) }
      catch { throw new CoreError('storage_error', '交互数据格式无效') }
    }
    const schema = record(decoded) ? decoded : {}, context = record(schema.context) ? schema.context : {}, target = context.secret_target
    if (!pythonTruthy(schema.secret_fields) || !record(target) || target.kind !== 'mcp_credentials') throw new InteractionNotFoundError()
    return { session_id: Number(row.session_id) }
  }
}

/** PG 调用方保有共享连接池的关闭职责。 */
export function createPostgresAgentInteractionSession(pool: Pick<Pool, 'query' | 'connect'>) {
  return createSqlAgentInteractionSession(new Kysely<any>({ dialect: new PostgresDialect({ pool: pool as Pool }) }), 'postgres')
}
