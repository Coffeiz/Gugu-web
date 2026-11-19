import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/modules/agent-sessions/tools/agent-tool-registry.js'
import { createAgentTrashListPort } from '../../src/modules/agent-sessions/tools/agent-trash-tool.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('真实注册器与隔离PG回收站复用owner及顶层过滤，微秒排序和组禁用保持只读', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `agent_trash_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 2 })
  const owner = randomUUID(), other = randomUUID()
  try {
    await pool.query(`CREATE TABLE projects(id integer PRIMARY KEY,user_id uuid,name text,color text);
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,project_id integer,workspace_directory_id integer,parent_id integer,name text,version integer,deleted_at timestamptz);
      CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,space text,workspace_directory_id integer,project_id integer,stage_name text,
        folder_id integer,mind_map_id integer,size text,size_bytes bigint,mime_type text,created_at timestamptz,deleted_at timestamptz,img_width integer,img_height integer,version integer)`)
    await pool.query(`INSERT INTO folders VALUES
      (10,$1,NULL,NULL,NULL,'根目录',1,'2026-11-15 00:00:00.000002+00'),
      (11,$1,NULL,5,NULL,'工作区目录',1,'2026-11-15 00:00:00.000003+00'),
      (12,$1,NULL,NULL,10,'已删父目录内的子目录',1,'2026-11-15 00:00:00.999999+00'),
      (13,$2,NULL,NULL,NULL,'他人目录',1,'2026-11-15 00:00:00.999999+00')`, [owner, other])
    for (const [id, user, folder, deleted] of [[1, owner, null, '2026-11-15 00:00:00.000001+00'],
      [2, owner, 10, '2026-11-15 00:00:00.999999+00'], [3, other, null, '2026-11-15 00:00:00.999999+00'], [4, owner, null, null]] as const)
      await pool.query(`INSERT INTO files(id,user_id,display_name,ext,space,folder_id,size,size_bytes,created_at,deleted_at,version,stage_name)
        VALUES($1,$2,$3,'txt','personal',$4,'1 B',1,'2026-11-01 00:00:00+00',$5,1,'')`, [id, user, `文件${id}`, folder, deleted])
    let allowed = true
    const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, trash: createAgentTrashListPort(pool, 'synthetic-test-cursor-key'), authorize: async (_identity, name) => allowed && name === 'list_trash' })
    const identity = { ownerId: owner, sessionId: '1', runId: 'trash' }
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行进程') } }
    const call = { id: 'list', name: 'list_trash', input: { owner_id: other } }
    const before = (await pool.query('SELECT * FROM files ORDER BY id')).rows
    const result = await registry.tools.dispatch(call, scope)
    assert.equal(result.kind, 'completed')
    if (result.kind === 'completed') assert.deepEqual(result.value, [
      { id: 11, folder_id: 11, kind: 'folder', name: '工作区目录', space: 'workspace', deleted_at: '2026-11-15T00:00:00.000003+00:00' },
      { id: 10, folder_id: 10, kind: 'folder', name: '根目录', space: 'personal', deleted_at: '2026-11-15T00:00:00.000002+00:00' },
      { id: 1, file_id: 1, kind: 'file', name: '文件1.txt', space: 'personal', deleted_at: '2026-11-15T00:00:00.000001+00:00' },
    ])
    const foreign = await registry.tools.dispatch(call, { ...scope, identity: { ...identity, ownerId: other } })
    assert.equal(foreign.kind, 'completed')
    if (foreign.kind === 'completed') assert.equal((foreign.value as unknown[]).length, 2)
    const truncated = await registry.tools.dispatch({ ...call, input: { limit: 2 } }, scope)
    assert.equal(truncated.kind, 'completed')
    if (truncated.kind === 'completed') assert.deepEqual((truncated.value as { items: Array<{ id: number }> }).items.map(row => row.id), [11, 10])
    registry.configure({ groups: { trash: false } })
    assert.deepEqual(await registry.capabilities(identity), [])
    assert.match(JSON.stringify(await registry.tools.dispatch(call, scope)), /工具不存在或未开放/)
    registry.configure({ groups: { trash: true } }); allowed = false
    assert.match(JSON.stringify(await registry.tools.dispatch(call, scope)), /没有权限/)
    allowed = true
    const cancel = new AbortController(); cancel.abort()
    await assert.rejects(registry.tools.dispatch(call, { ...scope, signal: cancel.signal }))
    assert.deepEqual((await pool.query('SELECT * FROM files ORDER BY id')).rows, before)
    await pool.query('DROP TABLE files')
    const failed = await registry.tools.dispatch(call, scope)
    assert.match(JSON.stringify(failed), /工具执行失败/)
    assert.doesNotMatch(JSON.stringify(failed), /relation|SELECT|does not exist/)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
