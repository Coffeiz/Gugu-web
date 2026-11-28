import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createAgentWorkspaceQueries, createKyselyAgentWorkspaceReader } from '@gugu/core/workspaces'
import { projectWorkspaces } from '@gugu/database/postgres/migrations/0037_project_workspaces'
import { createWebProjectWorkspaceBinding, readWebProjectWorkspaceLinks, webWorkspaceLocation } from '../../src/modules/workspaces/project-links.js'
import { createProjectFileOverviewPort } from '../../src/modules/agent/tools/overview.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('项目工作区关联检查 owner、保留文件，并通过项目概览返回沙箱路径', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_overview_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  const root = await mkdtemp(join(tmpdir(), 'gugu-project-overview-'))
  try {
    await pool.query('CREATE TABLE projects(id integer,user_id uuid,name text,start_date text,created_at timestamptz,deleted_at timestamptz, UNIQUE (id,user_id))')
    await pool.query(`CREATE TABLE workspace_directories (
      id integer, user_id uuid, name text, directory_name text, deleted_at timestamptz, UNIQUE (id,user_id));
      CREATE TABLE workspaces (id integer PRIMARY KEY, user_id uuid, directory_id integer, project_id integer,
        name text, kind text, enabled boolean, is_default boolean DEFAULT FALSE, updated_at timestamptz DEFAULT now());
      CREATE TABLE conversation_sessions (id integer, user_id uuid, workspace_id integer)`)
    await projectWorkspaces.apply(pool)
    const owner = randomUUID(), other = randomUUID()
    await pool.query("INSERT INTO projects VALUES (1,$1,'合成项目','2026-01-01',now(),NULL),(2,$2,'他人项目','2026-01-01',now(),NULL)", [owner, other])
    const project = join(root, owner, '项目文件', '2026', '01', '合成项目 #1')
    await mkdir(join(project, '目录'), { recursive: true })
    await writeFile(join(project, '根.txt'), '根')
    await writeFile(join(project, '目录', '子.txt'), '子')
    const read = createProjectFileOverviewPort(pool, root)
    const identity = { ownerId: owner, sessionId: '1', runId: 'test' }
    const signal = new AbortController().signal
    if (process.platform === 'linux') assert.deepEqual(await read(identity, 1, signal), {
      total_file_count: 2, root_file_count: 1, total_folder_count: 1,
      location: { kind: 'sandbox', value: '/project/2026/01/合成项目 #1' },
    })
    await assert.rejects(read(identity, 2, signal), { code: 'not_found' })
    await pool.query("INSERT INTO workspace_directories VALUES (7,$1,'样本目录','stable-root',NULL),(8,$2,'他人目录','foreign-root',NULL)", [owner, other])
    await pool.query("INSERT INTO workspaces (id,user_id,directory_id,name,kind,enabled) VALUES (31,$1,7,'样本目录','directory',true),(32,$2,8,'他人目录','directory',true)", [owner, other])
    const queries = createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(runtime.db, 'postgres', webWorkspaceLocation))
    const listed = await queries.list(owner, signal)
    assert.deepEqual(listed.map(item => [item.workspace_id, item.location]), [
      [31, { kind: 'sandbox', value: '/workspace/stable-root' }],
    ])
    assert.equal(await queries.get(owner, 32, signal), null)
    const workspace = join(root, owner, 'workspace', 'stable-root')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, '样本.txt'), '合成内容')
    let allowed = false
    const apply = createWebProjectWorkspaceBinding(runtime.db, async () => allowed)
    const args = { project_id: 1, workspace_id: 31, bound: true }
    await assert.rejects(apply(identity, args, signal), { code: 'conflict' })
    allowed = true
    await assert.rejects(apply(identity, { ...args, project_id: 2 }, signal), { code: 'not_found' })
    await assert.rejects(apply(identity, { ...args, workspace_id: 32 }, signal), { code: 'not_found' })
    assert.equal(await apply(identity, args, signal), true)
    assert.equal(await apply(identity, args, signal), false)
    const bound = await readWebProjectWorkspaceLinks(pool, owner, 1)
    assert.deepEqual(bound, [{ id: 31, name: '样本目录', available: true,
      location: { kind: 'sandbox', value: '/workspace/stable-root' } }])
    if (process.platform === 'linux') assert.deepEqual((await read(identity, 1, signal)).workspaces, bound)
    assert.equal(await apply(identity, { ...args, bound: false }, signal), true)
    assert.deepEqual(await readWebProjectWorkspaceLinks(pool, owner, 1), [])
    assert.equal(await readFile(join(workspace, '样本.txt'), 'utf8'), '合成内容')
    assert.equal((await pool.query('SELECT id FROM workspaces WHERE id=31')).rowCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
