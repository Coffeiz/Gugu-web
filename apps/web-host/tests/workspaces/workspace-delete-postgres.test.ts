import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { CoreError, createWorkspaceDeleter } from '@gugu/core'
import { createPostgresRuntime } from '@gugu/core/data'
import { createKyselyWorkspaceDeletionRuntime } from '@gugu/core/workspaces'
import { createPostgresWorkspaceDeleter } from '../../src/domains/workspaces/persistence/workspace-delete.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'
const postgresOptions = { skip: !databaseUrl && '需显式提供隔离的 GUGU_WEBUI_TEST_DATABASE_URL' }
type Mode = 'host' | 'core'
type DeletionRuntime = ReturnType<typeof createKyselyWorkspaceDeletionRuntime>

async function withWorkspaceFixture(mode: Mode, work: (context: {
  pool: Pool
  remove: ReturnType<typeof createWorkspaceDeleter>
  deletionRuntime?: DeletionRuntime
}) => Promise<void>) {
  const schema = `gugu_workspace_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  let core: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
  try {
    await pool.query(`
      CREATE TABLE workspaces (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        kind varchar(20) NOT NULL,
        folder_id integer,
        project_id integer,
        directory_id integer,
        enabled boolean NOT NULL DEFAULT true,
        is_default boolean NOT NULL DEFAULT false
      )
    `)
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL
      )
    `)
    await pool.query(`
      CREATE TABLE scheduled_tasks (
        id integer PRIMARY KEY,
        user_id uuid,
        event_id integer,
        workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL,
        enabled boolean NOT NULL DEFAULT true
      )
    `)
    await pool.query(`
      CREATE TABLE file_sync_bindings (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        workspace_id integer REFERENCES workspaces(id) ON DELETE CASCADE,
        source varchar(24) NOT NULL
      )
    `)
    await pool.query(`
      CREATE TABLE terminal_sessions (
        id varchar(80) PRIMARY KEY,
        owner_id uuid NOT NULL,
        workspace_id integer REFERENCES workspaces(id) ON DELETE SET NULL
      )
    `)
    await pool.query('CREATE TABLE projects (id integer PRIMARY KEY, user_id uuid NOT NULL, name text NOT NULL)')
    await pool.query(
      "INSERT INTO workspaces (id, user_id, name, kind, project_id) VALUES (41, $1, '工作区', 'project', 9)",
      [ownerId],
    )
    await pool.query(
      "INSERT INTO projects (id, user_id, name) VALUES (9, $1, '保留项目')",
      [ownerId],
    )
    await pool.query(
      `INSERT INTO conversation_sessions (id, user_id, workspace_id)
       VALUES (101, $1, 41), (102, $2, 41)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      `INSERT INTO scheduled_tasks (id, user_id, event_id, workspace_id, enabled)
       VALUES (201, $1, NULL, 41, true), (202, $1, 7, 41, true), (203, $2, NULL, 41, true)`,
      [ownerId, otherOwnerId],
    )
    await pool.query(
      `INSERT INTO file_sync_bindings (id, user_id, workspace_id, source) VALUES (301, $1, 41, 'local_directory')`,
      [ownerId],
    )
    await pool.query(
      `INSERT INTO terminal_sessions (id, owner_id, workspace_id) VALUES ('terminal-1', $1, 41)`,
      [ownerId],
    )

    let deletionRuntime: DeletionRuntime | undefined
    if (mode === 'core') {
      core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 1 })
      deletionRuntime = createKyselyWorkspaceDeletionRuntime(core.db as unknown as Parameters<typeof createKyselyWorkspaceDeletionRuntime>[0], 'postgres')
    }
    const remove = deletionRuntime ? createWorkspaceDeleter(deletionRuntime) : createPostgresWorkspaceDeleter(pool)
    await work({ pool, remove, deletionRuntime })
  } finally {
    try { await core?.close() } finally {
      try { await pool.end() } finally {
        try {
          if (!/^gugu_workspace_delete_[a-f0-9]{32}$/.test(schema)) throw new Error('测试schema范围无效')
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
        } finally { await admin.end() }
      }
    }
  }
}

for (const mode of ['host', 'core'] as const) {
  test(`PostgreSQL 删除工作区仅清理归属绑定、停用普通任务且保留底层项目（${mode}）`, postgresOptions, async () => {
    await withWorkspaceFixture(mode, async ({ pool, remove }) => {
      await assert.rejects(remove(otherOwnerId, 41), (error: unknown) =>
        error instanceof CoreError && error.code === 'not_found',
      )
      assert.equal((await pool.query('SELECT id FROM workspaces WHERE id = 41')).rowCount, 1)
      assert.deepEqual(await remove(ownerId, 41), { ok: true, workspaceId: 41 })

      assert.deepEqual((await pool.query('SELECT workspace_id FROM conversation_sessions ORDER BY id')).rows, [
        { workspace_id: null }, { workspace_id: null },
      ])
      assert.deepEqual((await pool.query('SELECT event_id, workspace_id, enabled FROM scheduled_tasks ORDER BY id')).rows, [
        { event_id: null, workspace_id: null, enabled: false },
        { event_id: 7, workspace_id: null, enabled: true },
        { event_id: null, workspace_id: null, enabled: true },
      ])
      assert.deepEqual((await pool.query('SELECT id, name FROM projects')).rows, [{ id: 9, name: '保留项目' }])
      assert.equal((await pool.query('SELECT id FROM file_sync_bindings WHERE id = 301')).rowCount, 0)
      assert.deepEqual((await pool.query('SELECT workspace_id FROM terminal_sessions WHERE id = $1', ['terminal-1'])).rows, [
        { workspace_id: null },
      ])
      assert.equal((await pool.query('SELECT id FROM workspaces WHERE id = 41')).rowCount, 0)
    })
  })
}

/** 完整比较删除声明前后的公开持久状态，覆盖手工解绑及FK联动。 */
async function persistentState(pool: Pool) {
  const statements = [
    'SELECT * FROM workspaces ORDER BY id',
    'SELECT * FROM conversation_sessions ORDER BY id',
    'SELECT * FROM scheduled_tasks ORDER BY id',
    'SELECT * FROM file_sync_bindings ORDER BY id',
    'SELECT * FROM terminal_sessions ORDER BY id',
    'SELECT * FROM projects ORDER BY id',
  ]
  const rows = []
  for (const statement of statements) rows.push((await pool.query(statement)).rows)
  return rows
}

test('Core Kysely真实SQL删除后触发器故障回滚全部绑定及级联副作用', postgresOptions, async () => {
  await withWorkspaceFixture('core', async ({ pool, remove }) => {
    const before = await persistentState(pool)
    // 真实数据库故障发生在DELETE后；前面的会话解绑、任务停用也必须回滚。
    await pool.query(`
      CREATE FUNCTION reject_workspace_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '合成工作区删除故障'; END $$;
      CREATE TRIGGER reject_workspace_delete AFTER DELETE ON workspaces
      FOR EACH ROW EXECUTE FUNCTION reject_workspace_delete()
    `)
    await assert.rejects(remove(ownerId, 41))
    assert.deepEqual(await persistentState(pool), before)
  })
})

test('Core Kysely实际DELETE后取消在事务提交前回滚工作区及FK副作用', postgresOptions, async () => {
  await withWorkspaceFixture('core', async ({ pool, deletionRuntime }) => {
    assert.ok(deletionRuntime)
    const before = await persistentState(pool)
    const controller = new AbortController(), reason = new Error('合成删除取消')
    // 仅包装真实事务中的方法：每条数据语句仍由生产Kysely适配器执行。
    const cancelling: Parameters<typeof createWorkspaceDeleter>[0] = {
      transaction(work, options) {
        return deletionRuntime.transaction(tx => work({
          lockOwnedWorkspace: (owner, id) => tx.lockOwnedWorkspace(owner, id),
          detachSessions: (owner, id) => tx.detachSessions(owner, id),
          disableOrdinaryTasks: (owner, id) => tx.disableOrdinaryTasks(owner, id),
          async deleteDeclaration(owner, id) {
            await tx.deleteDeclaration(owner, id)
            controller.abort(reason)
          },
        }), options)
      },
    }
    await assert.rejects(createWorkspaceDeleter(cancelling)(ownerId, 41, { signal: controller.signal }), error => error === reason)
    assert.deepEqual(await persistentState(pool), before)
  })
})
