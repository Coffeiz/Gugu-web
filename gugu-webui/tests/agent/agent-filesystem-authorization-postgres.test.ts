import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import test from 'node:test'
import {
  AgentFilesystemAuthorizationError,
  createAgentSessionFilesystemAuthorization,
  type FilesystemAuthorizationConfirmationPort,
} from '../../src/domains/agent-sessions/agent-filesystem-authorization.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

function confirmationPort(): FilesystemAuthorizationConfirmationPort {
  const pending = new Map<string, string>()
  const granted = new Set<string>()
  const pendingByCode = new Map<string, string>()
  const identityKey = (ownerId: string, summary: string, identity: string) => `${ownerId}\0${summary}\0${identity}`
  return {
    async revoke(ownerId, summary, identity) {
      const key = identityKey(ownerId, summary, identity)
      const code = pending.get(key)
      pending.delete(key)
      granted.delete(key)
      if (code) pendingByCode.delete(code)
      return true
    },
    async createPending(ownerId, summary, identity, ttlMinutes) {
      assert.equal(ttlMinutes, 10)
      const key = identityKey(ownerId, summary, identity)
      const code = 'a1b2c3d4e5f6'
      pending.set(key, code)
      pendingByCode.set(code, key)
      return code
    },
    async redeem(ownerId, code) {
      const key = pendingByCode.get(code)
      if (!key || !key.startsWith(`${ownerId}\0`)) return false
      pendingByCode.delete(code)
      granted.add(key)
      return true
    },
    async hasGrant(ownerId, summary, identity) {
      return granted.has(identityKey(ownerId, summary, identity))
    },
  }
}

test('授权申请、确认、撤销在 owner 隔离的 PostgreSQL 事务中写入 grant 与脱敏审计，并关闭交互 PTY', {
  skip: !databaseUrl && '需要显式隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL',
}, async () => {
  const schema = `gugu_filesystem_auth_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const ownerId = randomUUID()
  const otherOwnerId = randomUUID()
  const terminated: string[] = []
  const runtime = {
    enabled: () => true,
    secretKey: 'synthetic-filesystem-authorization-secret',
    async terminateActivePty(id: string) { terminated.push(id) },
    now: () => new Date('2026-11-14T00:00:00.000Z'),
  }

  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (
        id integer PRIMARY KEY, user_id uuid NOT NULL, title varchar(300)
      );
      CREATE TABLE filesystem_authorization_grants (
        id serial PRIMARY KEY, user_id uuid NOT NULL, subject_type varchar(24) NOT NULL,
        subject_id varchar(64) NOT NULL, scope varchar(32) NOT NULL,
        permission varchar(32) NOT NULL, granted_by varchar(16) NOT NULL,
        granted_at timestamptz NOT NULL, expires_at timestamptz,
        revoked_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE security_events (
        id serial PRIMARY KEY, user_id uuid NOT NULL, event_type varchar(80) NOT NULL,
        resource_type varchar(120) NOT NULL, resource_fingerprint varchar(64) NOT NULL,
        owner_fingerprint varchar(64), client_fingerprint varchar(64), ip_fingerprint varchar(64),
        user_agent_fingerprint varchar(64), action varchar(32) NOT NULL,
        reason_code varchar(80) NOT NULL, metadata_json jsonb NOT NULL,
        occurred_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE terminal_sessions (
        id serial PRIMARY KEY, owner_id uuid NOT NULL, session_id integer NOT NULL,
        mode varchar(32) NOT NULL, status varchar(32) NOT NULL, pty_pid integer,
        pty_sandbox_id varchar(128), pty_cols integer, pty_rows integer,
        closed_at timestamptz, updated_at timestamptz NOT NULL
      );
    `)
    await pool.query(
      `INSERT INTO conversation_sessions (id, user_id, title) VALUES
       (42, $1, '合成授权会话'), (43, $2, '其他用户会话')`, [ownerId, otherOwnerId],
    )
    const operations = createAgentSessionFilesystemAuthorization(pool, confirmationPort(), runtime)

    await assert.rejects(
      operations.request(otherOwnerId, 42),
      (error: unknown) => error instanceof AgentFilesystemAuthorizationError && error.statusCode === 404,
    )
    const requested = await operations.request(ownerId, 42) as Record<string, unknown>
    assert.equal(requested.status, 'waiting_confirmation')
    assert.equal(requested.needs_confirm, true)
    assert.equal(requested.authorization_ttl_minutes, 10)
    assert.equal(requested.confirm_code, 'a1b2c3d4e5f6')
    assert.deepEqual((await pool.query('SELECT id FROM filesystem_authorization_grants')).rows, [])
    assert.equal((await pool.query("SELECT reason_code FROM security_events WHERE reason_code='requested'")).rowCount, 1)

    await assert.rejects(
      operations.confirm(otherOwnerId, 42, 'a1b2c3d4e5f6'),
      (error: unknown) => error instanceof AgentFilesystemAuthorizationError && error.statusCode === 404,
    )
    const confirmed = await operations.confirm(ownerId, 42, 'a1b2c3d4e5f6') as Record<string, unknown>
    assert.equal(confirmed.status, 'authorized')
    assert.equal(confirmed.session_id, 42)
    assert.equal(typeof confirmed.grant_id, 'number')
    await assert.rejects(
      operations.confirm(ownerId, 42, 'a1b2c3d4e5f6'),
      (error: unknown) => error instanceof AgentFilesystemAuthorizationError && error.statusCode === 400,
    )

    await pool.query(
      `INSERT INTO terminal_sessions (owner_id, session_id, mode, status, pty_pid, pty_sandbox_id,
                                      pty_cols, pty_rows, updated_at)
       VALUES ($1, 42, 'interactive-pty', 'running', 1234, 'synthetic-container', 80, 24, now())`,
      [ownerId],
    )
    const revoked = await operations.revoke(ownerId, 42) as Record<string, unknown>
    assert.deepEqual(revoked, { status: 'revoked', session_id: 42, revoked: true })
    assert.deepEqual(terminated, ['1'])
    const grant = (await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM filesystem_authorization_grants WHERE id=$1', [confirmed.grant_id],
    )).rows[0]
    assert.ok(grant?.revoked_at)
    const terminal = (await pool.query<{ status: string; pty_pid: number | null; closed_at: Date | null }>(
      'SELECT status, pty_pid, closed_at FROM terminal_sessions WHERE owner_id=$1 AND session_id=42', [ownerId],
    )).rows[0]
    assert.equal(terminal?.status, 'terminated')
    assert.equal(terminal?.pty_pid, null)
    assert.ok(terminal?.closed_at)
    assert.equal((await pool.query("SELECT reason_code FROM security_events WHERE reason_code='revoked'")).rowCount, 1)

    const eventRows = await pool.query<{ resource_fingerprint: string; metadata_json: Record<string, string> }>(
      'SELECT resource_fingerprint, metadata_json FROM security_events ORDER BY id',
    )
    assert.equal(eventRows.rowCount, 3)
    assert.ok(eventRows.rows.every((event) => event.resource_fingerprint !== '42'))
    assert.ok(eventRows.rows.every((event) => event.metadata_json.subject_type === 'session'))
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})

test('功能关闭时拒绝申请，但仍允许撤销已有会话权限', async (t) => {
  if (!databaseUrl) return t.skip('需要显式隔离 PostgreSQL：设置 GUGU_WEBUI_TEST_DATABASE_URL')
  const schema = `gugu_filesystem_auth_disabled_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const ownerId = randomUUID()
  try {
    await pool.query(`
      CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid NOT NULL, title varchar(300));
      CREATE TABLE filesystem_authorization_grants (
        id serial PRIMARY KEY, user_id uuid NOT NULL, subject_type varchar(24) NOT NULL,
        subject_id varchar(64) NOT NULL, scope varchar(32) NOT NULL, permission varchar(32) NOT NULL,
        granted_by varchar(16) NOT NULL, granted_at timestamptz NOT NULL, expires_at timestamptz,
        revoked_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
      CREATE TABLE security_events (
        id serial PRIMARY KEY, user_id uuid NOT NULL, event_type varchar(80) NOT NULL,
        resource_type varchar(120) NOT NULL, resource_fingerprint varchar(64) NOT NULL,
        owner_fingerprint varchar(64), client_fingerprint varchar(64), ip_fingerprint varchar(64),
        user_agent_fingerprint varchar(64), action varchar(32) NOT NULL, reason_code varchar(80) NOT NULL,
        metadata_json jsonb NOT NULL, occurred_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE TABLE terminal_sessions (
        id serial PRIMARY KEY, owner_id uuid NOT NULL, session_id integer NOT NULL, mode varchar(32) NOT NULL,
        status varchar(32) NOT NULL, pty_pid integer, pty_sandbox_id varchar(128), pty_cols integer,
        pty_rows integer, closed_at timestamptz, updated_at timestamptz NOT NULL
      );
    `)
    await pool.query('INSERT INTO conversation_sessions (id,user_id,title) VALUES (42,$1,\'会话\')', [ownerId])
    const confirmations = confirmationPort()
    const operations = createAgentSessionFilesystemAuthorization(pool, confirmations, {
      enabled: () => false,
      secretKey: 'synthetic-filesystem-authorization-secret',
      async terminateActivePty() {},
    })
    await assert.rejects(
      operations.request(ownerId, 42),
      (error: unknown) => error instanceof AgentFilesystemAuthorizationError && error.statusCode === 409,
    )
    assert.deepEqual(await operations.revoke(ownerId, 42), {
      status: 'revoked', session_id: 42, revoked: false,
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
