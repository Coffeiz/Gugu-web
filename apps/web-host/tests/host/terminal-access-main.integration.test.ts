import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../src/modules/auth/session/token.js'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const rootfs = process.env.GUGU_BUBBLEWRAP_TEST_ROOTFS
async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return address.port
}

test('生产 Host 同步工作区导航、终端 API 与 Bubblewrap 就绪状态', {
  skip: (!databaseUrl || !rootfs || process.platform !== 'linux') && '需要隔离 PostgreSQL 和 Linux 运行根',
}, async () => {
  const schema = `terminal_access_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString(), max: 2 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-terminal-access-'))
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const config = join(root, 'config.json')
    await writeFile(config, '{}')
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
      is_active boolean NOT NULL, account_status text, security_version integer, avatar text, created_at timestamptz,
      timezone text, email_subscribed boolean, last_active_at timestamptz);
      CREATE TABLE user_bots(user_id uuid NOT NULL,platform text NOT NULL,enabled boolean NOT NULL);
      CREATE TABLE user_preferences(id serial PRIMARY KEY,user_id uuid NOT NULL UNIQUE,data_json text NOT NULL,updated_at timestamptz NOT NULL)`)
    const owner = randomUUID(), secret = 'synthetic-terminal-access-secret'
    await pool.query(`INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at,email_subscribed)
      VALUES ($1,'sample-owner','owner@example.test',true,'active',1,CURRENT_TIMESTAMP,false)`, [owner])
    host = await startServer({ GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: config, ...(rootfs === '/var/lib/gugu-sandbox/rootfs' ? {} : { GUGU_BUBBLEWRAP_ROOTFS: rootfs }),
      STORAGE__LOCAL_PATH: join(root, 'storage'), GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(await freePort()), GUGU_WEBUI_REDIS_URL: '' })
    const headers = (id: string) => ({ authorization: `Bearer ${createUserToken(id, 1, secret)}` })
    await pool.query(`CREATE TABLE workspaces(id integer, user_id uuid, name text, kind text,
      folder_id integer, project_id integer, directory_id integer, enabled boolean, is_default boolean, updated_at timestamptz);
      CREATE TABLE conversation_sessions(id integer, user_id uuid, workspace_id integer);
      CREATE TABLE terminal_sessions(owner_id uuid, status text, closed_at timestamptz, output_chars integer)`)
    const request = { headers: headers(owner) }
    const enabled = await host.app.inject({ ...request, url: '/api/v1/workspaces' })
    assert.equal(enabled.statusCode, 200)
    assert.equal(enabled.json().terminalEntryEnabled, true)
    assert.equal(enabled.json().ptyEnabled, true)
    assert.equal((await host.app.inject({ ...request, url: '/api/v1/terminals/metrics' })).statusCode, 200)

    for (const [mode, entry, pty, statusCode] of [
      ['pty_disabled', true, false, 200], ['entry_disabled', false, false, 403], ['auto', true, true, 200],
    ] as const) {
      await writeFile(config, JSON.stringify({ sandbox: { terminal_mode: mode } }))
      const workspace = await host.app.inject({ ...request, url: '/api/v1/workspaces' })
      assert.equal(workspace.statusCode, 200)
      assert.equal(workspace.json().terminalMode, mode)
      assert.equal(workspace.json().terminalEntryEnabled, entry)
      assert.equal(workspace.json().ptyEnabled, pty)
      assert.equal((await host.app.inject({ ...request, url: '/api/v1/terminals/metrics' })).statusCode, statusCode)
    }

    for (const sandbox of [{ enabled: false }, { network_profile: 'egress' }]) {
      await writeFile(config, JSON.stringify({ sandbox }))
      const disabled = await host.app.inject({ ...request, url: '/api/v1/workspaces' })
      assert.equal(disabled.statusCode, 200)
      assert.equal(disabled.json().terminalEntryEnabled, false)
      assert.equal(disabled.json().ptyEnabled, false)
      assert.equal((await host.app.inject({ ...request, url: '/api/v1/terminals/metrics' })).statusCode, 403)
    }
  } finally {
    await host?.close(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
