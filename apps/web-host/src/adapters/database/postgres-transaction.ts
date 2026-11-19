import type { Pool, PoolClient } from 'pg'

/** 统一执行 PostgreSQL 事务，保留业务异常并确保连接归还连接池。 */
export async function withPostgresTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  work: (client: PoolClient) => Promise<T>,
  mapError: (error: unknown) => unknown = (error) => error,
): Promise<T> {
  const client = await pool.connect()
  let discardConnection = false
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      discardConnection = true
    }
    throw mapError(error)
  } finally {
    client.release(discardConnection)
  }
}
