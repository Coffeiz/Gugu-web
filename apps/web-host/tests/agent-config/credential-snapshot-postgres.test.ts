import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { readPostgresLlmCredentialSnapshot } from '../../src/modules/byok/store.js'
import { bindRecoverableProvider } from '../../src/modules/agent/llm/recovery.js'
import { createAtomicAgentModelSnapshot } from '../../src/modules/agent/llm/snapshot.js'
const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('PG 快照按 owner 隔离并捕获密文变化，不依赖更新时间', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_model_${randomUUID().replaceAll('-', '')}`, admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  try {
    await pool.query(`CREATE TABLE user_provider_credentials (id integer PRIMARY KEY, user_id text, capability text, enabled boolean, provider text, api_format text, base_url text, model text, encrypted_value text, nonce text, encrypted_data_key text, key_version integer, max_tokens integer, context_tokens integer, thinking text, reasoning_effort text, reasoning_persistence text, image boolean, video boolean, audio boolean, image_detail text, web_search_enabled boolean, updated_at timestamptz DEFAULT now())`)
    await pool.query("INSERT INTO user_provider_credentials VALUES (1,'owner-a','llm',true,'openai','','https://provider.example.test','model-a','synthetic-cipher-a','nonce','wrapped',1,NULL,NULL,NULL,NULL,'off',false,false,false,'auto',false), (2,'owner-b','llm',true,'other','','','model-b','synthetic-cipher-b','nonce','wrapped',1,NULL,NULL,NULL,NULL,'off',false,false,false,'auto',false)")
    await pool.query(`CREATE TABLE user_provider_bindings AS
      SELECT user_id, capability, id AS credential_id FROM user_provider_credentials WHERE enabled`)

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

    await pool.query(`INSERT INTO user_provider_credentials
      SELECT 3, user_id, capability, false, provider, api_format, base_url, 'model-c',
        encrypted_value, nonce, encrypted_data_key, key_version, max_tokens, context_tokens, thinking,
        reasoning_effort, reasoning_persistence, image, video, audio, image_detail, web_search_enabled, updated_at
      FROM user_provider_credentials WHERE id=1`)
    const run = { ownerId: 'owner-a', sessionId: '1', runId: 'pinned-run' }
    const signal = new AbortController().signal
    const services = {
      async select(...args: Parameters<typeof select>) {
        const snapshot = await select(...args)
        return { ...snapshot, config: { ...snapshot.config, provider: 'openai', context_tokens: 128_000 } }
      },
      decryptCredential: () => 'synthetic-key',
      defaultBaseUrl: () => 'https://provider.example.test',
      verifyCredential: select.verifyCredential,
    }
    const bind = (id?: number) => bindRecoverableProvider(run, services, 'synthetic-binding-key', signal, undefined, id)
    const first = await bind()
    const recovery = { identity: run, modelIdentity: first.modelIdentity, accessScopeHash: first.accessScopeHash }
    const explicitlySelected = await bind(3)
    assert.equal((await explicitlySelected.resolve(run, explicitlySelected.modelIdentity, signal)).config.model, 'model-c')
    explicitlySelected.release()
    await assert.rejects(bind(2), /指定的 LLM 凭据不可用/)
    await pool.query("UPDATE user_provider_bindings SET credential_id=3 WHERE user_id='owner-a'")
    const resumed = await bindRecoverableProvider(run, services, 'synthetic-binding-key', signal, recovery)
    assert.equal((await resumed.resolve(run, resumed.modelIdentity, signal)).config.model, 'model-a')
    resumed.release()
    const next = await bind()
    assert.equal((await next.resolve(run, next.modelIdentity, signal)).config.model, 'model-c')
    next.release()
    await pool.query("UPDATE user_provider_credentials SET encrypted_value='rotated' WHERE id=1")
    await assert.rejects(first.resolve(run, first.modelIdentity, signal), /指定的 LLM 凭据不可用/)
    first.release()
    await assert.rejects(bindRecoverableProvider(run, services, 'synthetic-binding-key', signal, recovery), /原 LLM 凭据版本已变化/)

    await pool.query("UPDATE user_provider_credentials SET base_url='',model='' WHERE id=3")
    await assert.rejects(bind(), /指定的 LLM 凭据不可用/)
    await pool.query("DELETE FROM user_provider_bindings WHERE user_id='owner-a'")
    const fallback = await bind()
    assert.equal((await fallback.resolve(run, fallback.modelIdentity, signal)).config.model, 'platform')
    const servicePin = { identity: run, modelIdentity: fallback.modelIdentity, accessScopeHash: fallback.accessScopeHash }
    fallback.release()
    await pool.query("INSERT INTO user_provider_bindings VALUES ('owner-a','llm',3)")
    const resumedService = await bindRecoverableProvider(run, services, 'synthetic-binding-key', signal, servicePin)
    assert.equal((await resumedService.resolve(run, resumedService.modelIdentity, signal)).config.model, 'platform')
    resumedService.release()

  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
