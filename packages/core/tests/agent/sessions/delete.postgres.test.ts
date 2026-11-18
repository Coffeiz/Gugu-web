import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { Kysely, PostgresDialect } from 'kysely'
import { test } from 'vitest'
import { createPostgresAgentSessionDeleteRepository } from '../../../src/agent/sessions/delete-data.js'
import { tablesSql } from '../../../src/data/schema.js'
import { createSqlRagRebuildWorker } from '../../../src/agent/rag/rebuild-worker.js'

const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
test('会话删除在 PostgreSQL 同事务清理正文、关闭终端、撤下索引并推进重建代数', { skip: !url && 'requires isolated GUGU_CORE_TEST_POSTGRES_URL' }, async () => {
  const schema = `agent_session_delete_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid NOT NULL);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer NOT NULL REFERENCES conversation_sessions(id));
      CREATE TABLE chat_attachments(id integer PRIMARY KEY,user_id uuid NOT NULL,message_id integer NOT NULL REFERENCES conversation_messages(id),storage_key text NOT NULL);
      CREATE TABLE terminal_sessions(id text PRIMARY KEY,owner_id uuid NOT NULL,session_id integer REFERENCES conversation_sessions(id) ON DELETE SET NULL,source text NOT NULL,status text NOT NULL,closed_at timestamptz,updated_at timestamptz NOT NULL);
    `)
    const { ragJobs, ragIndexEntries } = tablesSql('postgres')
    await pool.query(ragJobs)
    await pool.query(ragIndexEntries)
    const owner = randomUUID(), foreignOwner = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1),(2,$2),(3,$1)', [owner, foreignOwner])
    await pool.query('INSERT INTO conversation_messages VALUES (11,1),(22,2)')
    await pool.query("INSERT INTO chat_attachments VALUES (1,$1,11,'shared'),(2,$1,11,'orphan')", [owner])
    await pool.query("INSERT INTO terminal_sessions VALUES ('agent-1',$1,1,'agent','running',NULL,now()),('manual-1',$1,1,'user','running',NULL,now())", [owner])
    await pool.query(`INSERT INTO knowledge_index_entries
      (owner_user_id,source_type,source_id,document_id,document_version,content_hash,title,content,metadata_json)
      VALUES ($1,'conversation','11','deleted-message','v1','hash','合成标题','合成正文','{"session_id":"1"}'),
             ($1,'conversation','11','deleted-old-version','v0','hash','旧标题','旧正文','{"session_id":"1"}'),
             ($1,'conversation','1:summary','deleted-summary','v1','hash','合成标题','合成摘要','{"session_id":"1"}'),
             ($1,'conversation','31','kept-session','v1','hash','','其他会话','{"session_id":"3"}'),
             ($2,'conversation','22','kept-owner','v1','hash','','其他账号','{"session_id":"2"}')`, [owner, foreignOwner])
    await pool.query("UPDATE knowledge_index_entries SET deleted_at=now() WHERE document_id='deleted-old-version'")
    await pool.query(`INSERT INTO rag_index_jobs
      (user_id,source_type,source_id,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
      VALUES($1,'conversation','','','refresh','queued',7,6,1,now()-interval '1 minute',now(),now())`, [owner])
    const repository = createPostgresAgentSessionDeleteRepository(pool)
    const claimed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
    const work = createSqlRagRebuildWorker(db, 'postgres', {
      async conversation() {
        claimed.resolve()
        await release.promise
        return []
      },
    })
    const stale = work()
    try {
      await Promise.race([claimed.promise, stale.then(result => assert.fail(`旧任务未成功领取：${result}`))])
      assert.deepEqual(await repository.delete(owner, 1), { storageKeys: ['orphan', 'shared'] })
    } finally {
      release.resolve()
      await stale
    }
    assert.equal(await stale, 'superseded')
    assert.equal((await pool.query('SELECT id FROM conversation_sessions WHERE id=1')).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM conversation_messages WHERE session_id=1')).rowCount, 0)
    assert.equal((await pool.query('SELECT id FROM chat_attachments WHERE message_id=11')).rowCount, 0)
    const terminals = await pool.query<{ id: string; status: string; closed_at: Date | null; session_id: number | null }>('SELECT id,status,closed_at,session_id FROM terminal_sessions ORDER BY id')
    assert.deepEqual(terminals.rows.map(row => [row.id,row.status,row.closed_at !== null,row.session_id]), [
      ['agent-1','terminated',true,null], ['manual-1','running',false,null],
    ])
    assert.equal(await repository.delete(owner, 2), null)
    assert.deepEqual((await pool.query(`SELECT document_id,deleted_at IS NOT NULL AS deleted,content,content_hash
      FROM knowledge_index_entries ORDER BY document_id`)).rows, [
      { document_id: 'deleted-message', deleted: true, content: '', content_hash: '' },
      { document_id: 'deleted-old-version', deleted: true, content: '', content_hash: '' },
      { document_id: 'deleted-summary', deleted: true, content: '', content_hash: '' },
      { document_id: 'kept-owner', deleted: false, content: '其他账号', content_hash: 'hash' },
      { document_id: 'kept-session', deleted: false, content: '其他会话', content_hash: 'hash' },
    ])
    assert.equal((await pool.query(`SELECT 1 FROM knowledge_index_entries
      WHERE deleted_at IS NOT NULL AND (title<>'' OR metadata_json::jsonb<>'{}'::jsonb)`)).rowCount, 0)
    assert.deepEqual((await pool.query('SELECT generation,completed_generation,status,lease_until FROM rag_index_jobs WHERE user_id=$1', [owner])).rows, [
      { generation: 8, completed_generation: 6, status: 'queued', lease_until: null },
    ])

    await pool.query("ALTER TABLE rag_index_jobs ADD CONSTRAINT synthetic_reject_rebuild CHECK (source_type <> 'conversation') NOT VALID")
    await assert.rejects(repository.delete(owner, 3), { code: '23514' })
    assert.equal((await pool.query('SELECT 1 FROM conversation_sessions WHERE id=3')).rowCount, 1)
    assert.equal((await pool.query("SELECT 1 FROM knowledge_index_entries WHERE document_id='kept-session' AND deleted_at IS NULL")).rowCount, 1)

    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT synthetic_reject_rebuild')
    await pool.query('DROP TABLE terminal_sessions,knowledge_index_entries')
    assert.deepEqual(await repository.delete(foreignOwner, 2), { storageKeys: [] })
    assert.equal((await pool.query('SELECT 1 FROM conversation_sessions WHERE id=2')).rowCount, 0)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
