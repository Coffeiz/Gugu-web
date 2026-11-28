import { Pool } from 'pg'
import { createPostgresPool } from '@gugu/database/postgres/pool'
import { type WebUiConfig } from '../config.js'

export function createPool(config: WebUiConfig, max = config.postgresPoolMax): Pool {
  return createPostgresPool(Pool, {
    connectionString: config.databaseUrl,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  })
}
