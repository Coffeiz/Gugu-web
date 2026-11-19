import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresPurgeLeaseStore } from '../../src/modules/files/trash-purge-worker-postgres.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('回收站租约全局互斥、失租接管与 owner 条件进度', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `purge_lease_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE trash_purge_jobs (
      id serial PRIMARY KEY,user_id uuid NOT NULL,status varchar(16) NOT NULL,snapshot_at timestamptz NOT NULL,
      progress_current integer NOT NULL,progress_total integer NOT NULL,failed_count integer NOT NULL,error_code varchar(64),
      lease_owner varchar(128),lease_until timestamptz,created_at timestamptz NOT NULL,started_at timestamptz,finished_at timestamptz
    ); CREATE UNIQUE INDEX uq_trash_purge_jobs_user_active ON trash_purge_jobs(user_id) WHERE status IN ('queued','running');
      CREATE UNIQUE INDEX uq_trash_purge_jobs_global_running ON trash_purge_jobs(status) WHERE status='running';
      CREATE INDEX ix_trash_purge_jobs_claim ON trash_purge_jobs(status,lease_until,created_at)`)
    await pool.query(`CREATE TABLE folders (id serial PRIMARY KEY,user_id uuid NOT NULL,parent_id integer,deleted_at timestamptz);
      CREATE TABLE files (id serial PRIMARY KEY,user_id uuid NOT NULL,folder_id integer,deleted_at timestamptz)`)
    const users = [randomUUID(), randomUUID()]
    await pool.query(`INSERT INTO trash_purge_jobs(user_id,status,snapshot_at,progress_current,progress_total,failed_count,created_at)
      VALUES($1,'queued','2026-11-14T00:00:00Z',0,2,0,'2026-11-14T00:00:00Z'),($2,'queued','2026-11-14T00:00:00Z',0,1,0,'2026-11-14T00:00:01Z')`, users)
    await pool.query(`INSERT INTO files(user_id,deleted_at) VALUES
      ($1,'2026-11-13T23:00:00Z'),($1,'2026-11-13T23:00:01Z'),($2,'2026-11-13T23:00:00Z')`, users)
    let current = Date.parse('2026-11-14T01:00:00Z')
    const store = createPostgresPurgeLeaseStore(pool, 60_000, () => new Date(current))
    const claims = await Promise.all([store.claim('worker-a'), store.claim('worker-b')])
    assert.equal(claims.filter(Boolean).length, 1)
    const winner = claims[0] ? 'worker-a' : 'worker-b'
    const loser = claims[0] ? 'worker-b' : 'worker-a'
    const first = claims.find(Boolean)!
    assert.equal(await store.renew(first.id, loser), false)
    assert.equal(await store.advance(first.id, loser), false)
    assert.equal(await store.claim(loser), null)
    await pool.query('DELETE FROM files WHERE id=(SELECT min(id) FROM files WHERE user_id=$1)', [first.userId])
    current += 60_001
    assert.equal(await store.renew(first.id, winner), false)
    assert.equal(await store.finish(first.id, winner, 'completed'), false)
    const resumed = await store.claim(loser)
    assert.equal(resumed?.id, first.id)
    assert.equal(resumed?.progressCurrent, 1)
    assert.equal(await store.advance(first.id, winner), false)
    assert.equal(await store.advance(first.id, loser), true)
    assert.equal(await store.finish(first.id, loser, 'completed', null, 2), true)
    const next = await store.claim(winner)
    assert.ok(next && next.id !== first.id)
    assert.equal(await store.finish(next.id, winner, 'failed', 'purge_failed'), true)
    const rows = await pool.query('SELECT status,progress_current,failed_count,error_code,lease_owner FROM trash_purge_jobs ORDER BY id')
    assert.deepEqual(rows.rows.find(row => row.status === 'completed'), { status: 'completed', progress_current: 2, failed_count: 0, error_code: null, lease_owner: null })
    assert.deepEqual(rows.rows.find(row => row.status === 'failed'), { status: 'failed', progress_current: 0, failed_count: 1, error_code: 'purge_failed', lease_owner: null })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
