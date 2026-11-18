import assert from 'node:assert/strict'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { createUserSkillReader } from '../../../src/agent/skills/user-body.js'

test('单个用户 Skill 正文只读取当前 owner 的启用 user 来源记录', async () => {
  const file = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: file }) })
  const owner = '00000000-0000-4000-8000-000000000101'
  const other = '00000000-0000-4000-8000-000000000102'
  const ownerKey = owner.replaceAll('-', '')
  const otherKey = other.replaceAll('-', '')
  file.exec(`
    CREATE TABLE user_skills(
      owner_id TEXT NOT NULL,skill_id TEXT NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,
      source TEXT NOT NULL,enabled INTEGER NOT NULL,content_digest TEXT NOT NULL,
      UNIQUE(owner_id,skill_id)
    );
  `)
  const insert = file.prepare('INSERT INTO user_skills VALUES(?,?,?,?,?,?,?)')
  insert.run(ownerKey, 'U1', '用户技能', 'owner body', 'user', 1, 'digest-owner')
  insert.run(otherKey, 'U1', '他人技能', 'other body', 'user', 1, 'digest-other')
  insert.run(ownerKey, 'U2', '停用技能', 'disabled body', 'user', 0, 'digest-disabled')
  insert.run(ownerKey, 'U3', '非用户来源', 'builtin body', 'builtin', 1, 'digest-builtin')

  try {
    const read = createUserSkillReader(db, 'sqlite')
    assert.deepEqual(await read(owner, 'u1'), { id: 'U1', name: '用户技能', body: 'owner body', contentDigest: 'digest-owner' })
    assert.deepEqual(await read(other, 'U1'), { id: 'U1', name: '他人技能', body: 'other body', contentDigest: 'digest-other' })
    assert.equal(await read(owner, 'U2'), null)
    assert.equal(await read(owner, 'U3'), null)
    assert.equal(await read(owner, 'S1'), null)
  } finally {
    await db.destroy()
  }
})
