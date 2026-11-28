import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'
import { readDesktopDataInventory } from '../../src/data-portability/desktop-inventory.js'
import { createUserSkillBundle } from '../../src/agent/skills/bundle-store.js'

it('用本地 SQLite 统计数据类别且只统计当前 owner 的技能', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-inventory-test-'))
  const database = join(directory, 'local.db')
  try {
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    try {
      const otherOwner = randomUUID()
      const document = '---\nname: 合成技能\ndescription: 合成描述\n---\n合成正文'
      await createUserSkillBundle(directory, otherOwner, 'demo', document)
      const before = await readDesktopDataInventory(runtime.db, ownerId, undefined, directory)
      expect(before).toMatchObject({ projects: 0, skills: 0, desktop_sessions: 0 })
      await createUserSkillBundle(directory, ownerId, 'demo', document)
      expect(await readDesktopDataInventory(runtime.db, ownerId, undefined, directory)).toEqual({ ...before, skills: 1 })
    } finally {
      await runtime.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
