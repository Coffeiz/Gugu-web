import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createMcpServerCreator } from '@gugu/core/mcp/server-create'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('MCP 创建限定 owner、仅保存信封密文并失效旧 Python 工具快照', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `gugu_mcp_create_${randomUUID().replaceAll('-', '')}`
  const owner = randomUUID(), foreign = randomUUID(), admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const runtime = await createPostgresRuntime({ url: databaseUrl!, schema })
  try {
    await pool.query(`CREATE TABLE user_mcp_servers (
      id uuid PRIMARY KEY,user_id uuid NOT NULL,scope text NOT NULL,name text NOT NULL,transport text NOT NULL,
      endpoint text NOT NULL,encrypted_endpoint text NOT NULL,endpoint_nonce text NOT NULL,encrypted_endpoint_key text NOT NULL,
      endpoint_key_version integer NOT NULL,command text NOT NULL,auth_mode text NOT NULL,
      encrypted_headers text NOT NULL,headers_nonce text NOT NULL,encrypted_headers_key text NOT NULL,headers_key_version integer NOT NULL,
      encrypted_query_params text NOT NULL,query_params_nonce text NOT NULL,encrypted_query_params_key text NOT NULL,query_params_key_version integer NOT NULL,
      credential_slots jsonb NOT NULL,encrypted_credentials text NOT NULL,credentials_nonce text NOT NULL,
      encrypted_credentials_key text NOT NULL,credentials_key_version integer NOT NULL,enabled boolean NOT NULL,
      confirm_mode text NOT NULL,timeout_seconds integer NOT NULL,tool_allowlist jsonb NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
      UNIQUE(user_id,scope,name)
    ); CREATE TABLE user_mcp_tool_schema_snapshots(user_id uuid PRIMARY KEY,config_digest text NOT NULL,schemas jsonb NOT NULL,refreshed_at timestamptz NOT NULL)`)
    await pool.query('INSERT INTO user_mcp_tool_schema_snapshots VALUES($1,$2,$3,clock_timestamp()),($4,$2,$3,clock_timestamp())', [owner, 'old-owner-snapshot', '[]', foreign])
    const create = createMcpServerCreator(runtime.db, {
      maxServersPerUser: 1,
      id: () => '00000000-0000-7000-8000-000000000001',
      async encrypt(plaintext) {
        return { ciphertext: `cipher:${plaintext}`, nonce: 'synthetic-nonce', encryptedDataKey: 'synthetic-wrapped-key', keyVersion: 1 }
      },
    })
    const input = {
      name: 'weather', transport: 'http' as const, endpoint: 'https://mcp.example/rpc?key={{secret:api}}', command: '',
      credential_slots: [{ id: 'api', label: 'API key', target: 'query' as const, name: 'key', prefix: '' }],
      credential_values: { api: 'synthetic-secret' }, enabled: true, confirm_mode: 'confirm_all', timeout_seconds: 30,
      tool_allowlist: ['forecast'],
    }
    const result = await create(owner, input)
    assert.equal(result.name, 'weather')
    assert.equal(result.endpoint, input.endpoint)
    assert.deepEqual(result.credential_values, input.credential_values)
    assert.deepEqual(result.credential_state, { configured: true, slot_ids: ['api'] })
    const stored = (await pool.query('SELECT * FROM user_mcp_servers WHERE user_id=$1', [owner])).rows[0]
    assert.equal(stored.endpoint, '')
    assert.equal(stored.encrypted_endpoint, `cipher:${input.endpoint}`)
    assert.equal(stored.encrypted_credentials, 'cipher:{"api":"synthetic-secret"}')
    assert.equal(stored.encrypted_endpoint.includes('synthetic-secret'), false)
    assert.equal((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots ORDER BY user_id')).rowCount, 1)
    assert.equal((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots')).rows[0].user_id, foreign)

    await assert.rejects(create(owner, { ...input, name: 'second', endpoint: 'https://mcp.example/other' }), (error: unknown) =>
      (error as { code?: string }).code === 'invalid_request')
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_mcp_servers')).rows[0].count, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_mcp_tool_schema_snapshots')).rows[0].count, 1)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
