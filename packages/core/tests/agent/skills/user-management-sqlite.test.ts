import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import SQLite from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { test } from 'vitest'
import { CoreError } from '../../../src/contracts/index.js'
import { createUserSkillManager } from '../../../src/agent/skills/user-management.js'

test('SQLite Skill 更新保留 MCP 关联、允许用户接管并隔离 owner', async () => {
  const file = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: file }) })
  const owner = '00000000-0000-4000-8000-000000000101'
  const other = '00000000-0000-4000-8000-000000000102'
  const events: string[] = []
  file.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY,next_skill_sequence INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE user_skills(
      id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,skill_id TEXT NOT NULL,
      name TEXT NOT NULL,description_short TEXT NOT NULL,description_long TEXT,category TEXT NOT NULL,
      body TEXT NOT NULL,related_tools TEXT NOT NULL,source TEXT NOT NULL,managed_by TEXT,
      enabled INTEGER NOT NULL,content_digest TEXT NOT NULL,created_at TEXT,updated_at TEXT,
      UNIQUE(owner_id,skill_id)
    );
  `)
  const ownerKey = owner.replaceAll('-', '')
  file.prepare('INSERT INTO users(id,next_skill_sequence) VALUES(?,1)').run(ownerKey)
  file.prepare(`INSERT INTO user_skills(owner_id,skill_id,name,description_short,category,body,related_tools,source,managed_by,enabled,content_digest)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(ownerKey, 'S1', '旧技能', '旧摘要', 'other', '旧正文', '[]', 'assistant', 'assistant', 1, 'old')
  const manager = createUserSkillManager(db, 'sqlite', {
    async knownTools() { return new Set(['builtin_search']) },
    digest(body) { return createHash('sha256').update(body).digest('hex').slice(0, 16) },
    async publish(changedOwner) { events.push(changedOwner) },
  })

  try {
    const created = await manager.create(owner, {
      name: '新技能', description_short: '新摘要', description_long: null, category: 'personal',
      body: '创建正文', related_tools: [], enabled: false,
    })
    assert.equal(created.id, 'U1')
    assert.equal(created.enabled, false)
    const updated = await manager.update(owner, 'S1', {
      managed_by: 'user', category: null, related_tools: ['mcp_notes_search'], body: '新正文',
    })
    assert.equal(updated.managed_by, 'user')
    assert.equal(updated.category, 'personal')
    assert.deepEqual(updated.related_tools, ['mcp_notes_search'])
    assert.equal(updated.body, '新正文')
    assert.equal((await manager.list(owner))[0]?.managed_by, 'user')
    await assert.rejects(manager.update(other, 'S1', { body: '越权' }), (error: unknown) => error instanceof CoreError && error.code === 'not_found')
    assert.deepEqual(events, [owner, owner])
  } finally {
    await db.destroy()
  }
})
