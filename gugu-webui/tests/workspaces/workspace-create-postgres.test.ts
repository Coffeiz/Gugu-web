import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { createPostgresWorkspaceCreator } from '../../src/domains/workspaces/persistence/workspace-create.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const ownerId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'
const otherOwnerId = 'ad0902a0-c899-44ee-b180-d54eb04e4604'

test('POST workspace 创建校验 kind 关联对象归属与 directory 绑定', {
  skip: !databaseUrl && 'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration',
}, async () => {
  const schema = `gugu_workspace_create_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  try {
    await pool.query('CREATE TABLE folders (id integer PRIMARY KEY, user_id uuid NOT NULL)')
    await pool.query('CREATE TABLE projects (id integer PRIMARY KEY, user_id uuid NOT NULL)')
    await pool.query(`
      CREATE TABLE workspace_directories (
        id integer PRIMARY KEY,
        user_id uuid NOT NULL,
        deleted_at timestamptz
      )
    `)
    await pool.query(`
      CREATE TABLE workspaces (
        id serial PRIMARY KEY,
        user_id uuid NOT NULL,
        name varchar(200) NOT NULL,
        kind varchar(20) NOT NULL DEFAULT 'folder',
        folder_id integer,
        project_id integer,
        directory_id integer,
        enabled boolean NOT NULL DEFAULT true,
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await pool.query('INSERT INTO folders (id, user_id) VALUES (11, $1), (12, $2)', [ownerId, otherOwnerId])
    await pool.query('INSERT INTO projects (id, user_id) VALUES (21, $1), (22, $2)', [ownerId, otherOwnerId])
    await pool.query(
      'INSERT INTO workspace_directories (id, user_id, deleted_at) VALUES (31, $1, NULL), (32, $2, NULL), (33, $1, CURRENT_TIMESTAMP)',
      [ownerId, otherOwnerId],
    )

    const create = createPostgresWorkspaceCreator(pool)
    const folder = await create(ownerId, { name: ' 文件夹环境 ', folderId: 11 })
    assert.deepEqual(folder, {
      id: folder.id,
      name: '文件夹环境',
      kind: 'folder',
      folderId: 11,
      projectId: null,
      directoryId: null,
      enabled: true,
      isDefault: false,
      boundSessionCount: 0,
    })

    const project = await create(ownerId, {
      name: '项目环境', kind: 'project', projectId: 21, folderId: 11, enabled: false,
    })
    assert.equal(project.projectId, 21)
    assert.equal(project.folderId, null, 'project kind 清除不相关的 folder 绑定')
    assert.equal(project.enabled, false)

    const directory = await create(ownerId, { name: '目录环境', kind: 'directory', directoryId: 31 })
    assert.equal(directory.directoryId, 31)
    assert.equal(directory.folderId, null)
    assert.equal(directory.projectId, null)
    const persistedDirectoryBinding = await pool.query(
      'SELECT user_id::text AS user_id, kind, directory_id FROM workspaces WHERE id = $1',
      [directory.id],
    )
    assert.deepEqual(persistedDirectoryBinding.rows[0], {
      user_id: ownerId, kind: 'directory', directory_id: 31,
    })

    await assert.rejects(create(ownerId, { name: '越权文件夹', folderId: 12 }), { code: 'conflict' })
    await assert.rejects(create(ownerId, { name: '越权项目', kind: 'project', projectId: 22 }), { code: 'conflict' })
    await assert.rejects(create(ownerId, { name: '越权目录', kind: 'directory', directoryId: 32 }), { code: 'conflict' })
    await assert.rejects(create(ownerId, { name: '已删除目录', kind: 'directory', directoryId: 33 }), { code: 'conflict' })
    await assert.rejects(create(ownerId, { name: '缺少 folder id' }), { code: 'conflict' })
    await assert.rejects(create(ownerId, { name: '非法类型', kind: 'global' }), { code: 'invalid_request' })
    await assert.rejects(create(ownerId, { name: '' }), { code: 'invalid_request' })

    const rows = await pool.query('SELECT user_id::text AS user_id, name, kind FROM workspaces ORDER BY id')
    assert.deepEqual(rows.rows, [
      { user_id: ownerId, name: '文件夹环境', kind: 'folder' },
      { user_id: ownerId, name: '项目环境', kind: 'project' },
      { user_id: ownerId, name: '目录环境', kind: 'directory' },
    ])
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
