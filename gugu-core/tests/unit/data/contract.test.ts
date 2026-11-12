import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { dataContract } from '../../fixtures/data-contract.js'

dataContract('临时 SQLite 的项目/联系人同逻辑回归', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'gugu-contract-')),
    path = join(folder, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path, {
      clock: () => '2026-11-10T10:00:00.123456Z',
    })
    return {
      runtime,
      owner: ownerId,
      other: randomUUID(),
      close: async () => {
        await runtime.close()
        rmSync(folder, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        })
      },
    }
  } catch (error) {
    rmSync(folder, { recursive: true, force: true })
    throw error
  }
})
