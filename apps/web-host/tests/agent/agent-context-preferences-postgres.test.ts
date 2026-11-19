import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createLocalPreferenceTextFiles } from '../../src/modules/preferences/persistence/personality-files.js'
import { createAgentPreferenceContextSources } from '../../src/modules/agent/context/preferences.js'
import { ensureSessionSnapshot, stableJson } from '@gugu/core/agent'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('时区、偏好文件与版本均绑定会话 owner，缺失偏好不读取其他用户数据', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `pref_${randomUUID().replaceAll('-', '')}`, root = await mkdtemp(path.join(tmpdir(), 'agent-preference-')), admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,timezone text); CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid); CREATE TABLE user_preferences(user_id uuid,data_json text)')
    const owner = randomUUID(), other = randomUUID(), identity = { ownerId: owner, sessionId: '1' }
    await pool.query("INSERT INTO users VALUES ($1,'Asia/Tokyo'),($2,'bad-zone')", [owner, other])
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1),(2,$2)', [owner, other])
    await pool.query('INSERT INTO user_preferences VALUES ($1,$2)', [owner, JSON.stringify({ locale: 'ja-JP', custom_reply_style: '旧风格', custom_reply_style_enabled: true, personality_preference_enabled: true, personality_preference_revision: 4 })])
    const files = createLocalPreferenceTextFiles(root)
    await files.write(owner, 'reply-style', '  新风格  '); await files.write(owner, 'personality', '  温和  ')
    let revision = '7'
    const service = createAgentPreferenceContextSources(pool, files, { async get(key) { assert.equal(key, `context-revision:${owner}`); return revision } }, 'UTC')
    assert.equal(await service.loadTimezone(identity), 'Asia/Tokyo')
    assert.deepEqual(await service.loadStylePreferences(identity), { custom_reply_style_enabled: true, custom_reply_style: '新风格', locale: 'ja-JP', personality_preference_enabled: true, personality_preference: '温和', personality_preference_revision: 4 })
    assert.equal(await service.currentRevision(identity), 7)
    let loads = 0
    const snapshotPorts = { digest: (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex'), nextId: randomUUID, now: () => 100,
      currentRevision: service.currentRevision, async loadContext() { loads++; return { systemPrompt: '系统', snapshotContext: '快照', sessionInfo: {}, userTimezone: await service.loadTimezone(identity) } } }
    const first = await ensureSessionSnapshot(identity, { ...identity, context: null, contextEpoch: 0, snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }, snapshotPorts)
    revision = '8'; assert.equal(await service.currentRevision(identity), 8)
    const reused = await ensureSessionSnapshot(identity, first.state, snapshotPorts)
    assert.equal(reused.phase, 'hit'); assert.equal(loads, 1); assert.equal(reused.state.context?.context_revision, 7)
    await assert.rejects(service.loadStylePreferences({ ...identity, ownerId: other }), /会话不存在/)
    assert.equal(await service.loadTimezone({ ownerId: other, sessionId: '2' }), 'UTC')
    assert.deepEqual(await service.loadStylePreferences({ ownerId: other, sessionId: '2' }), {})
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(root, { recursive: true, force: true }) }
})
