import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely'
import pg from 'pg'
import SQLite from 'better-sqlite3'
import { test } from 'vitest'
import { createWorkspaceDeclarationCreator, createWorkspaceDeclarationUpdater } from '../../../src/workspaces/workspace-declarations.js'
import { createKyselyWorkspaceDeclarationRuntime } from '../../../src/workspaces/workspace-declarations-store.js'
import type { WorkspaceDeclarationDatabase } from '../../../src/workspaces/workspace-declarations-store.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('工作区双库测试必须显式提供隔离 PostgreSQL')
async function contract(db: Kysely<WorkspaceDeclarationDatabase>, backend: 'sqlite' | 'postgres') {
  const id = backend === 'sqlite' ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'
  const boolean = backend === 'sqlite' ? 'INTEGER' : 'BOOLEAN'
  const statements = [
    `CREATE TABLE workspace_directories (id ${id}, user_id TEXT NOT NULL, name TEXT NOT NULL, directory_name TEXT NOT NULL, is_system ${boolean} NOT NULL, is_default ${boolean} NOT NULL, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    'CREATE UNIQUE INDEX workspace_names ON workspace_directories(user_id,name) WHERE deleted_at IS NULL',
    'CREATE UNIQUE INDEX workspace_segments ON workspace_directories(user_id,directory_name) WHERE deleted_at IS NULL',
    `CREATE TABLE workspaces (id ${id}, user_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, folder_id INTEGER, project_id INTEGER, directory_id INTEGER, enabled ${boolean} NOT NULL, is_default ${boolean} NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE folders (id ${id}, user_id TEXT NOT NULL, deleted_at TEXT)`,
    `CREATE TABLE projects (id ${id}, user_id TEXT NOT NULL, deleted_at TEXT)`,
    `CREATE TABLE conversation_sessions (id ${id}, user_id TEXT NOT NULL, workspace_id INTEGER)`,
  ]
  for (const statement of statements) await sql.raw(statement).execute(db)
  const owner = randomUUID(), other = randomUUID(), user = backend === 'sqlite' ? owner.replaceAll('-', '') : owner
  const now = new Date().toISOString(), no = backend === 'sqlite' ? 0 : false
  await db.insertInto('workspace_directories').values([{ user_id: user, name: '原名称', directory_name: 'fixed', is_default: no, is_system: no, deleted_at: null, created_at: now, updated_at: now },
    { user_id: user, name: '已占用', directory_name: 'other', is_default: no, is_system: no, deleted_at: null, created_at: now, updated_at: now }]).execute()
  await db.insertInto('projects').values({ user_id: user, deleted_at: now }).execute()
  const runtime = createKyselyWorkspaceDeclarationRuntime(db, backend)
  const create = createWorkspaceDeclarationCreator(runtime), update = createWorkspaceDeclarationUpdater(runtime)
  await assert.rejects(create(other, { name: '越权', kind: 'directory', directoryId: 1 }), { code: 'conflict' })
  const a = await create(owner, { name: '原名称', kind: 'directory', directoryId: 1 })
  const b = await create(owner, { name: '原名称', kind: 'directory', directoryId: 1 })
  await create(owner, { name: '回收项目', kind: 'project', projectId: 1 })
  await db.insertInto('conversation_sessions').values([{ user_id: user, workspace_id: a.id }, { user_id: other, workspace_id: a.id }]).execute()
  const changed = await update(owner, a.id, { name: '新名称', enabled: false })
  assert.equal(changed.boundSessionCount, 1)
  assert.equal(changed.enabled, false)
  assert.equal((await db.selectFrom('workspaces').select('name').where('id', '=', b.id).executeTakeFirstOrThrow()).name, '新名称')
  assert.equal((await db.selectFrom('workspace_directories').select('directory_name').where('id', '=', 1).executeTakeFirstOrThrow()).directory_name, 'fixed')
  await assert.rejects(update(owner, a.id, { name: '已占用', enabled: true }), { statusCode: 400 })
  assert.equal((await db.selectFrom('workspaces').select('enabled').where('id', '=', a.id).executeTakeFirstOrThrow()).enabled, no)
  await assert.rejects(update(other, a.id, { enabled: true }), { statusCode: 404 })
}
test('工作区声明共享事务在隔离 SQLite 与 PostgreSQL 保持归属、计数和目录行为', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-workspace-contract-'))
  const schema = `workspace_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: url })
  await admin.connect()
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const sqlite = new Kysely<WorkspaceDeclarationDatabase>({ dialect: new SqliteDialect({ database: new SQLite(join(folder, 'core.db')) }) })
  const postgres = new Kysely<WorkspaceDeclarationDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` }) }) })
  try { await contract(sqlite, 'sqlite'); await contract(postgres, 'postgres') }
  finally { await sqlite.destroy(); await postgres.destroy(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(folder, { recursive: true, force: true }) }
})
