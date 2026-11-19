import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import { loadSessionHistory } from '@gugu/core/agent'
import { createPostgresCanonicalHistoryReader } from '../../src/modules/agent/chat/canonical.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('历史读取隔离 owner，并用摘要覆盖水位排除旧正文与待消费消息', { skip: !databaseUrl && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_history_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid, baseline_message_seq bigint, source text, baseline_message_hash text, snapshot_hash text);
      CREATE TABLE conversation_messages (id serial PRIMARY KEY, session_id integer, conversation_seq bigint, history_anchor_seq bigint,
      role text, content text, content_json jsonb, covers_until_seq bigint, run_id text, round_id text, canonical_batch_id bigint,
      im_platform_sent_ms bigint, im_event_received_ms bigint, created_at timestamp, sent_at timestamp, quoted_text text,
      files jsonb, platform_user_id text, platform_user_name text, chat_type text, provider_image_content json)`)
    const ownerId = randomUUID()
    await pool.query(`INSERT INTO conversation_sessions VALUES (1,$1,1,'web','hash','snapshot')`, [ownerId])
    await pool.query(`INSERT INTO conversation_messages (session_id,conversation_seq,role,content,covers_until_seq,run_id) VALUES
      (1,1,'user','旧正文',NULL,NULL),(1,2,'summary','摘要',2,NULL),
      (1,3,'user','新正文',NULL,NULL),(1,4,'user','待消费',NULL,'im-pending:synthetic')`)
    const image = [null, '旧内容', { type: 'text', text: '合成消息' }, { type: 'image', source: { type: 'base64', data: 'synthetic' } }]
    await pool.query('UPDATE conversation_messages SET provider_image_content=$1::json WHERE session_id=1 AND conversation_seq=3', [JSON.stringify(image)])
    const reader = createPostgresCanonicalHistoryReader(pool)
    const history = await loadSessionHistory({ ownerId, sessionId: '1' }, reader)
    assert.equal(history.effectiveBaselineSeq, 2)
    assert.deepEqual(history.rows.map(row => row.content), ['摘要', '新正文'])
    const withImages = await loadSessionHistory({ ownerId, sessionId: '1' }, reader, undefined, { loadImages: true })
    assert.deepEqual(withImages.rows.find(row => row.content === '新正文')?.providerImageContent, image)
    await assert.rejects(reader.read({ ownerId: randomUUID(), sessionId: '1' }), /会话不存在/)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
