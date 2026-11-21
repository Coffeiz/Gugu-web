import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { readDesktopDataInventory } from '../../src/data-portability/desktop-inventory.js'
import { desktopSkills } from '../../src/runtime/desktop-resources.js'

it('用本地 SQLite 统计数据类别且只统计当前 owner 的技能', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-inventory-test-'))
  const database = join(directory, 'local.db')
  try {
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    try {
      const otherOwner = randomUUID()
      await runtime.db.transaction().execute(async trx => {
        await desktopSkills(trx, otherOwner).write(undefined, {
          name: '小北的技能', description_short: '合成描述', body: '合成正文',
        })
      })
      const before = await readDesktopDataInventory(runtime.db, ownerId)
      expect(before).toMatchObject({ projects: 0, skills: 0, desktop_sessions: 0 })
      await runtime.db.transaction().execute(async trx => {
        await desktopSkills(trx, ownerId).write(undefined, {
          name: '本地技能', description_short: '合成描述', body: '合成正文',
        })
      })
      expect(await readDesktopDataInventory(runtime.db, ownerId)).toEqual({ ...before, skills: 1 })
    } finally {
      await runtime.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
