import { createTerminalEventPageReader } from '@gugu/core/terminals/events'
import type { Pool } from 'pg'
import { createPostgresTerminalDetailReader } from './detail.js'

/** Reuses the detail authorization path, then reads owner-scoped persisted event pages from Core. */
export function createPostgresTerminalEventStream<DB>(pool: Pool, db: DB, runtime: Parameters<typeof createPostgresTerminalDetailReader>[2]) {
  const readDetail = createPostgresTerminalDetailReader(pool, db, runtime)
  const readPage = createTerminalEventPageReader(db as Parameters<typeof createTerminalEventPageReader>[0], 'postgres')
  return {
    async authorize(ownerId: string, terminalId: string): Promise<void> { await readDetail(ownerId, terminalId) },
    readPage,
  }
}
