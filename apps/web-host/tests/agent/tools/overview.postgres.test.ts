import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dataContext } from '@gugu/core'
import { createPostgresRuntime } from '@gugu/core/data'
import { createKyselyProjectCreateRuntime } from '@gugu/core/project-create-data'
import { tablesSql } from '../../../../../packages/core/src/data/schema.js'
import { createAgentToolRegistry } from '../../../src/modules/agent/tools/registry.js'
import { createProjectFileOverviewPort } from '../../../src/modules/agent/tools/overview.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('get_project 经真实注册器和隔离PG读取文件概览，保护owner、错误和取消', { skip: !url }, async () => {
  const schema = `gugu_tool_overview_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(`${tablesSql('postgres').projects};
      CREATE TABLE files(user_id uuid,project_id integer,space text,folder_id integer,deleted_at timestamptz);
      CREATE TABLE folders(user_id uuid,project_id integer,deleted_at timestamptz)`)
    const owner = randomUUID(), other = randomUUID()
    const project = await runtime.transaction(dataContext(owner), data => data.projects.create({ name: '合成项目', start_date: '2026-11-03' }))
    const foreign = await runtime.transaction(dataContext(other), data => data.projects.create({ name: '其他用户项目' }))
    const deleted = await runtime.transaction(dataContext(owner), data => data.projects.create({ name: '已删除项目' }))
    await pool.query('UPDATE projects SET deleted_at=now() WHERE id=$1', [deleted.id])
    await pool.query(`INSERT INTO files VALUES ($1,$3,'project',NULL,NULL),($1,$3,'project',10,NULL),
      ($1,$3,'project',NULL,now()),($1,$3,'personal',NULL,NULL),($2,$3,'project',NULL,NULL),($1,$4,'project',NULL,NULL)`, [owner, other, project.id, foreign.id])
    await pool.query('INSERT INTO folders VALUES ($1,$3,NULL),($1,$3,now()),($2,$3,NULL),($1,$4,NULL)', [owner, other, project.id, foreign.id])
    const actualOverview = createProjectFileOverviewPort(pool)
    let reads = 0, allowed = true
    const registry = createAgentToolRegistry({ core: runtime,
      projects: createKyselyProjectCreateRuntime({ db: runtime.db, backend: 'postgres', async publishProjectCreated() {} }),
      authorize: async (_identity, name) => allowed && name === 'get_project',
      fileOverview: async (...args) => { reads++; return actualOverview(...args) },
    })
    const scope = (ownerId = owner, signal = new AbortController().signal) => ({
      identity: { ownerId, sessionId: '1', runId: 'run' }, roundId: 'round', signal, resolution: null,
      execute: async () => { throw new Error('不允许宿主执行') },
    })
    const dispatch = (id: number, ownerId = owner, signal?: AbortSignal) => registry.tools.dispatch(
      { id: 'call', name: 'get_project', input: { project_id: id } }, scope(ownerId, signal))
    const found = await dispatch(project.id)
    assert.equal(found.kind, 'completed')
    if (found.kind !== 'completed') throw new Error('工具未完成')
    assert.equal(found.successful, true)
    assert.equal((found.value as { sandbox_path: string }).sandbox_path, `/project/2026/11/合成项目 #${project.id}`)
    assert.deepEqual((found.value as { files: unknown }).files, { total_file_count: 2, root_file_count: 1, total_folder_count: 1 })
    const before = reads
    const denied = await dispatch(foreign.id)
    assert.equal(denied.kind, 'completed')
    if (denied.kind === 'completed') assert.equal(denied.successful, false)
    assert.equal(reads, before)
    const removed = await dispatch(deleted.id)
    assert.equal(removed.kind, 'completed')
    if (removed.kind === 'completed') assert.equal(removed.successful, false)
    assert.equal(reads, before)
    const preCancelled = new AbortController(), preReason = new Error('合成预取消')
    preCancelled.abort(preReason)
    await assert.rejects(dispatch(project.id, owner, preCancelled.signal), error => error === preReason)
    assert.equal(reads, before)
    allowed = false
    const revoked = await dispatch(project.id)
    assert.equal(revoked.kind, 'completed')
    if (revoked.kind === 'completed') assert.equal(revoked.executed, false)
    assert.equal(reads, before)
    allowed = true

    const blocker = await pool.connect(), controller = new AbortController(), reason = new Error('合成取消')
    let locked = false
    try {
      await blocker.query('BEGIN'); await blocker.query('LOCK TABLE files IN ACCESS EXCLUSIVE MODE'); locked = true
      let settled = false
      const pending = dispatch(project.id, owner, controller.signal)
      const observed = pending.then(() => { settled = true; return null }, error => { settled = true; return error })
      const oid = await admin.query<{ oid: number }>('SELECT $1::regclass::oid AS oid', [`${schema}.files`])
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const locks = await admin.query<{ count: string }>('SELECT count(*) FROM pg_locks WHERE relation=$1 AND NOT granted', [oid.rows[0]!.oid])
        waiting = Number(locks.rows[0]!.count) > 0
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.equal(waiting, true)
      controller.abort(reason); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false)
      await blocker.query('COMMIT'); locked = false
      assert.equal(await observed, reason)
      assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1)
    } finally { if (locked) await blocker.query('ROLLBACK'); blocker.release() }

    await pool.query('ALTER TABLE files RENAME TO hidden_files')
    try {
      const failed = await dispatch(project.id)
      assert.equal(failed.kind, 'completed')
      if (failed.kind === 'completed') { assert.equal(failed.successful, false); assert.deepEqual(failed.value, { error: '工具执行失败' }) }
    } finally { await pool.query('ALTER TABLE hidden_files RENAME TO files') }
  } finally {
    await runtime.close(); await pool.end()
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`) } finally { await admin.end() }
  }
})
