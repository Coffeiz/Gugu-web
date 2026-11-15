import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createAgentImChannelLoader } from '../../src/domains/agent-sessions/context/agent-im-channels.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('渠道使用 owner 的已启用 Bot、当前与旧版可达记录及全局策略', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `agent_im_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE conversation_sessions(id int,user_id uuid); CREATE TABLE user_bots(user_id uuid,platform text,enabled bool)')
    const owner = randomUUID(), other = randomUUID()
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1),(2,$2)', [owner, other])
    await pool.query("INSERT INTO user_bots VALUES ($1,'qq',true),($1,'wechat',false),($2,'telegram',true),($1,'feishu',true)", [owner, other])
    const values = new Map([[`imreach:${owner}:wechat`, JSON.stringify({ platform: 'wechat', context_token: 'secret' })], [`imreach:${owner}`, JSON.stringify({ platform: 'telegram', chat_id: 'private' })]])
    const load = createAgentImChannelLoader({ pool, redis: { get: async key => values.get(key) ?? null }, enabled: platform => platform !== 'feishu' })
    assert.deepEqual(await load({ ownerId: owner, sessionId: '1' }), { feishu: false, qq: true, wechat: true, telegram: true })
    await assert.rejects(load({ ownerId: other, sessionId: '1' }), /会话不存在/)
    values.set(`imreach:${owner}:wechat`, 'secret-invalid')
    await assert.rejects(load({ ownerId: owner, sessionId: '1' }), error => error instanceof Error && error.message === 'IM 可达记录格式无效')
    const aborted = new AbortController(); aborted.abort()
    await assert.rejects(load({ ownerId: owner, sessionId: '1' }, aborted.signal))
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
