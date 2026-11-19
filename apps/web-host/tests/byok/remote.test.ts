import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRemoteByokClient } from '@gugu/core/byok/client'
import { migratePostgres } from '@gugu/database/postgres'
import { Pool } from 'pg'
import { startServer } from '../../src/main.js'
import { signedUserToken } from '../helpers/auth.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('桌面凭据客户端使用当前 Web Host 会话管理备用凭据和独立默认绑定', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = 'remote_byok_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', '-c search_path=' + schema)
  const pool = new Pool({ connectionString: scoped.toString(), max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-remote-byok-'))
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    assert.equal(await migratePostgres(pool, 'apply'), 'applied')
    const owner = randomUUID()
    const other = randomUUID()
    await pool.query(`INSERT INTO users(id, username, email, hashed_password)
      VALUES ($1,'local-owner','owner@example.test','fixture'), ($2,'local-other','other@example.test','fixture')`, [owner, other])
    const secret = 'synthetic-remote-byok-auth'
    const config = join(root, 'config.json')
    await writeFile(config, '{}')
    const socket = createServer()
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
    const address = socket.address()
    assert.ok(address && typeof address === 'object')
    await new Promise<void>(resolve => socket.close(() => resolve()))
    const origin = 'http://127.0.0.1:' + address.port
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: config, GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(address.port),
      GUGU_WEBUI_REDIS_URL: '', STORAGE__LOCAL_PATH: root, CREDENTIALS_MASTER_KEY: 'synthetic-remote-byok-master',
      BYOK__ENABLED: 'true',
    })
    const remote = createRemoteByokClient(async (input, init) => {
      assert.equal(new URL(String(input)).origin, origin)
      assert.equal(init?.redirect, 'error')
      return fetch(input, init)
    })
    const session = (accountId: string) => ({
      provider: 'self-hosted' as const, accountId, origin,
      token: signedUserToken(secret, accountId),
    })
    const input = {
      capability: 'llm' as const, provider: 'openai', api_format: 'openai',
      base_url: '', model: 'example-model', value: 'synthetic-provider-key',
    }
    const backup = await remote(session(owner), { action: 'create', input })
    assert.ok(backup && 'id' in backup)
    assert.equal(backup.enabled, false)
    assert.doesNotMatch(JSON.stringify(backup), /synthetic-provider-key|encrypted_value/)
    await assert.rejects(remote(session(other), { action: 'bind', id: backup.id }), { code: 'not_found' })
    assert.equal(await remote(session(owner), { action: 'bind', id: backup.id }), null)
    const listed = await remote(session(owner), { action: 'list' })
    assert.ok(listed && 'items' in listed)
    assert.deepEqual(listed.items, [{ ...backup, enabled: true }])
    const bindings = await pool.query('SELECT credential_id FROM user_provider_bindings WHERE user_id=$1', [owner])
    assert.deepEqual(bindings.rows, [{ credential_id: backup.id }])
    const changed = await remote(session(owner), { action: 'update', id: backup.id, input: { model: 'other-model' } })
    assert.ok(changed && 'model' in changed)
    assert.equal(changed.model, 'other-model')
    assert.equal(await remote(session(owner), { action: 'delete', id: backup.id }), null)
    assert.equal((await pool.query('SELECT 1 FROM user_provider_bindings WHERE user_id=$1', [owner])).rowCount, 0)
    assert.equal(await migratePostgres(pool, 'check'), 'applied')
  } finally {
    try { await host?.close() } finally {
      await pool.end()
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally {
        await admin.end()
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})
