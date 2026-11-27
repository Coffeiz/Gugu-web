import { openPostgresKysely } from '@gugu/database/postgres/kysely'
import { DatabaseError } from '@gugu/database/error'
import { CoreError } from '../contracts/index.js'
import { SqlDataRuntime } from './runtime.js'
import type { Clock } from './codec.js'

export async function createPostgresRuntime(config: {
  url: string
  schema?: string
  maxConnections?: number
  clock?: Clock
}): Promise<SqlDataRuntime> {
  try {
    return new SqlDataRuntime(openPostgresKysely(await import('pg'), config), 'postgres', config.clock)
  } catch (error) {
    throw error instanceof DatabaseError ? new CoreError(error.code, error.message) : error
  }
}
