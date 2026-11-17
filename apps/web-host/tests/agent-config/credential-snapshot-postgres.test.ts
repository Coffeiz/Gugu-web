import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { readPostgresLlmCredentialSnapshot } from '../../src/domains/agent-config/credential-snapshot-postgres.js'
import { createAtomicAgentModelSnapshot } from '../../src/domains/agent-config/atomic-model-snapshot.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PG 快照按 owner 隔离并捕获密文变化，不依赖更新时间', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_model_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`CREATE TABLE user_provider_credentials (id integer PRIMARY KEY, user_id text, capability text, enabled boolean, provider text, api_format text, base_url text, model text, encrypted_value text, nonce text, encrypted_data_key text, key_version integer, max_tokens integer, context_tokens integer, thinking text, reasoning_effort text, reasoning_persistence text, image boolean, video boolean, audio boolean, image_detail text, web_search_enabled boolean)`)
    await pool.query("INSERT INTO user_provider_credentials VALUES (1,'owner-a','llm',true,'openai','','https://provider.example.test','model-a','synthetic-cipher-a','nonce','wrapped',1,NULL,NULL,NULL,NULL,'off',false,false,false,'auto',false), (2,'owner-b','llm',true,'other','','','model-b','synthetic-cipher-b','nonce','wrapped',1,NULL,NULL,NULL,NULL,'off',false,false,false,'auto',false)")
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const first = await readPostgresLlmCredentialSnapshot(client, 'owner-a', 'synthetic-version-key')
      await pool.query("UPDATE user_provider_credentials SET encrypted_value='synthetic-cipher-new' WHERE id=1")
      const same = await readPostgresLlmCredentialSnapshot(client, 'owner-a', 'synthetic-version-key')
      assert.equal(first.credentialVersion, same.credentialVersion)
      assert.equal(first.credential?.model, 'model-a'); assert.doesNotMatch(first.credentialVersion, /synthetic/)
      await client.query('COMMIT')
      const changed = await readPostgresLlmCredentialSnapshot(client, 'owner-a', 'synthetic-version-key')
      assert.notEqual(first.credentialVersion, changed.credentialVersion)
      assert.equal((await readPostgresLlmCredentialSnapshot(client, 'owner-b', 'synthetic-version-key')).credential?.model, 'model-b')
      assert.equal((await readPostgresLlmCredentialSnapshot(client, 'owner-c', 'synthetic-version-key')).credential, null)
    } finally { client.release() }
    assert.throws(() => createAtomicAgentModelSnapshot(pool, 'synthetic-key', null, null), /一致性边界不可用/)
    let locked = false, released = 0
    const select = createAtomicAgentModelSnapshot(pool, 'synthetic-key', { async withLockedConfig(work) { locked = true; try { return await work() } finally { locked = false } },
      async readLockedModel(_id, ref) { assert.equal(locked, true); return { modelRef: ref ?? 'active', configVersion: 'config-v1', config: { model: 'platform' }, systemPrompt: '', byokEnabled: true, localDeployment: false, release() { released++ } } },
      async accessScope() { assert.equal(locked, true); return { contextScopeKey: 'b'.repeat(64), accessScopeHash: 'c'.repeat(64) } } }, null)
    const snapshot = await select({ ownerId: 'owner-a', sessionId: '1', runId: 'run' }, new AbortController().signal)
    assert.equal(snapshot.credential?.model, 'model-a'); assert.equal(snapshot.configVersion, 'config-v1'); snapshot.release(); assert.equal(released, 1)
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
