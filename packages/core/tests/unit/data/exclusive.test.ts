import { expect, it } from 'vitest'
import SQLite from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { dataContext } from '../../../src/contracts/index.js'

it('桌面独占连接阻止其他连接读取/写入，释放后保留数据与稳定 owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-exclusive-')),
    path = join(root, 'core.db')
  let current: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  let other: SQLite.Database | undefined
  try {
    await initializeSqlite(path)
    current = await openSqliteRuntime(path, { exclusive: true })
    await current.runtime.transaction(dataContext(current.ownerId), (data) =>
      data.projects.create({ name: '独占计划' }),
    )
    const owner = current.ownerId
    other = new SQLite(path)
    other.pragma('busy_timeout = 10')
    expect(() => other!.prepare('SELECT count(*) FROM projects').get()).toThrow(/locked/)
    other.close()
    other = undefined
    await current.runtime.close()
    current = undefined
    current = await openSqliteRuntime(path)
    expect(current.ownerId).toBe(owner)
    expect(
      await current.runtime.transaction(dataContext(owner), (data) => data.projects.list()),
    ).toMatchObject([{ name: '独占计划' }])
  } finally {
    other?.close()
    await current?.runtime.close()
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
})
