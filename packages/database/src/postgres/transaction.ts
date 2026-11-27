import type { Pool, PoolClient } from 'pg'

export function connectionFailed(error: unknown): boolean {
  const seen = new Set<Error>()
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error)
    const code = (error as Error & { code?: unknown }).code
    if (typeof code === 'string' && /^08[A-Z0-9]{3}$/.test(code)) return true
    error = error.cause
  }
  return false
}

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
    // 协议或传输断开后，直接丢弃该连接，不再往同一连接发送回滚命令。
    discardConnection = connectionFailed(error)
    if (!discardConnection) {
      try {
        await client.query('ROLLBACK')
      } catch {
        discardConnection = true
      }
    }
    throw mapError(error)
  } finally {
    client.release(discardConnection)
  }
}
