import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { startServer } from '../../src/main.js'
import { applyAgentBaseMigration } from '@gugu/database/postgres/migrations/0001_initialize'
import { applyFilesystemAuthorizationMigration, checkFilesystemAuthorizationMigration } from '@gugu/database/postgres/migrations/0005_filesystem_authorization'
import { applyWebDomainMigration } from '@gugu/database/postgres/migrations/0002_web_domain'
import { signedUserToken } from '../helpers/auth.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('空库生产 Host 默认启用授权，历史仅认同属主会话有效的完整沙箱授权', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `agent_history_grants_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString() })
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-history-grants-'))
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await assert.rejects(applyFilesystemAuthorizationMigration(pool), { code: 'incompatible' })
    await applyAgentBaseMigration(pool)
    await applyWebDomainMigration(pool)
    assert.equal(await checkFilesystemAuthorizationMigration(pool), 'pending')
    assert.deepEqual((await Promise.all([applyFilesystemAuthorizationMigration(pool), applyFilesystemAuthorizationMigration(pool)])).sort(),
      ['applied', 'unchanged'])
    assert.equal(await checkFilesystemAuthorizationMigration(pool), 'applied')

    const owner = randomUUID(), foreign = randomUUID(), secret = 'synthetic-agent-history-grant-secret'
    await pool.query(`INSERT INTO users(id,username,email,hashed_password)
      VALUES($1,'小北','north@example.test','synthetic'),($2,'小南','south@example.test','synthetic')`, [owner, foreign])
    const { rows: [session] } = await pool.query<{ id: number }>(
      "INSERT INTO conversation_sessions(user_id,source,title) VALUES($1,'web','合成授权会话') RETURNING id", [owner])
    const sessionId = session!.id
    const config = join(root, 'config.test.json')
    await writeFile(config, '{}')
    const probe = createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const address = probe.address()
    assert.ok(address && typeof address !== 'string')
    await new Promise<void>(resolve => probe.close(() => resolve()))
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret, GUGU_WEBUI_REDIS_URL: '',
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(address.port),
      GUGU_CONFIG_OVERRIDE_FILE: config, STORAGE__LOCAL_PATH: join(root, 'storage'),
    })
    const url = `/api/v1/agent/sessions/${sessionId}/messages`
    const history = (user = owner) => host!.app.inject({
      url, headers: { authorization: `Bearer ${signedUserToken(secret, user)}` },
    })
    assert.equal((await history(foreign)).statusCode, 404)
    async function assertAuthorized(expected: boolean) {
      const result = await history()
      assert.equal(result.statusCode, 200, result.body)
      assert.partialDeepStrictEqual(result.json().session, { filesystemAuthorizationEnabled: true, filesystemAuthorized: expected })
    }
    await assertAuthorized(false)
    await pool.query(`INSERT INTO filesystem_authorization_grants
      (user_id,subject_id,subject_type,scope,permission,expires_at,granted_at,created_at,updated_at)
      VALUES($1,$3,'session','user_sandbox','read_only',NULL,now(),now(),now()),
            ($1,$3,'session','workspace','read_write',NULL,now(),now(),now()),
            ($1,$3,'scheduled_task','user_sandbox','read_write',NULL,now(),now(),now()),
            ($1,$3,'session','user_sandbox','read_write',now()-interval '1 minute',now(),now(),now()),
            ($2,$3,'session','user_sandbox','read_write',NULL,now(),now(),now())`, [owner, foreign, String(sessionId)])
    await assertAuthorized(false)
    const result = await pool.query<{ id: number }>(`INSERT INTO filesystem_authorization_grants
      (user_id,subject_id,granted_at,created_at,updated_at) VALUES($1,$2,now(),now(),now()) RETURNING id`, [owner, String(sessionId)])
    await assertAuthorized(true)
    await pool.query('UPDATE filesystem_authorization_grants SET revoked_at=now() WHERE id=$1', [result.rows[0]!.id])
    await assertAuthorized(false)
    await pool.query('DELETE FROM users WHERE id=$1', [foreign])
    assert.equal((await pool.query('SELECT 1 FROM filesystem_authorization_grants WHERE user_id=$1', [foreign])).rowCount, 0)
  } finally {
    await host?.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally {
      await admin.end()
      await rm(root, { recursive: true, force: true })
    }
  }
})
