import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { CoreError } from '@gugu/core'
import { createMcpServerMutations } from '@gugu/core/mcp/server-mutations'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createMcpManagementEditOperations, createMcpManagementTool, createToolRegistry, type ClientDeleteConfirmationPort } from '@gugu/core/tools'
import { createWebAgentConfirmationAuthorization } from '../../src/domains/agent-sessions/tools/agent-confirmation.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const seal = (plaintext: string) => `sealed:${Buffer.from(plaintext, 'utf8').toString('base64')}`

test('MCP 配置更新和删除按 owner 写入密文并原子失效对应工具快照', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `gugu_mcp_mutations_${randomUUID().replaceAll('-', '')}`
  const owner = randomUUID(), foreign = randomUUID(), serverId = randomUUID()
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const runtime = await createPostgresRuntime({ url: databaseUrl!, schema })
  const decrypt = async (envelope: { ciphertext: string }) => Buffer.from(envelope.ciphertext.slice('sealed:'.length), 'base64').toString('utf8')
  const crypto = {
    async encrypt(plaintext: string) { return { ciphertext: seal(plaintext), nonce: 'nonce', encryptedDataKey: 'wrapped', keyVersion: 1 } },
    decrypt,
  }
  const mutations = createMcpServerMutations(runtime.db, {
    maxTools: 8,
    crypto,
  })
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
    await pool.query(`INSERT INTO user_mcp_servers (
      id,user_id,scope,name,transport,endpoint,encrypted_endpoint,endpoint_nonce,encrypted_endpoint_key,endpoint_key_version,
      command,auth_mode,encrypted_headers,headers_nonce,encrypted_headers_key,headers_key_version,
      encrypted_query_params,query_params_nonce,encrypted_query_params_key,query_params_key_version,
      credential_slots,encrypted_credentials,credentials_nonce,encrypted_credentials_key,credentials_key_version,
      enabled,confirm_mode,timeout_seconds,tool_allowlist,created_at,updated_at
    ) VALUES ($1,$2,'user','weather','http',${'$'}3,'','', '',1,'','headers','','','',1,'','','',1,
      ${'$'}4::jsonb,${'$'}5,'nonce','wrapped',1,true,'confirm_all',30,'[]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)` , [
      serverId, owner, 'https://mcp.example/old', JSON.stringify([{ id: 'api', label: 'API', target: 'header', name: 'Authorization', prefix: 'Bearer ' }]), seal('{"api":"old-secret"}'),
    ])
    await pool.query('INSERT INTO user_mcp_tool_schema_snapshots VALUES($1,$2,$3,clock_timestamp()),($4,$2,$3,clock_timestamp())', [owner, 'old-owner', '[]', foreign])

    const endpointMigration = await mutations.update(owner, serverId, { name: 'weather-legacy-migrated' })
    assert.equal(endpointMigration.endpoint, 'https://mcp.example/old')
    const legacyEndpoint = (await pool.query('SELECT endpoint,encrypted_endpoint FROM user_mcp_servers WHERE id=$1', [serverId])).rows[0]
    assert.equal(legacyEndpoint.endpoint, '')
    assert.equal(legacyEndpoint.encrypted_endpoint, seal('https://mcp.example/old'))

    const changed = await mutations.update(owner, serverId, {
      name: 'weather-v2', endpoint: 'https://mcp.example/new', enabled: false,
      credential_values: { api: 'new-secret' }, tool_allowlist: ['forecast'],
    })
    assert.equal(changed.name, 'weather-v2')
    assert.equal(changed.endpoint, 'https://mcp.example/new')
    assert.deepEqual(changed.credential_values, { api: 'new-secret' })
    assert.equal(changed.enabled, false)
    const stored = (await pool.query('SELECT * FROM user_mcp_servers WHERE id=$1', [serverId])).rows[0]
    assert.equal(stored.encrypted_endpoint, seal('https://mcp.example/new'))
    assert.equal(stored.encrypted_credentials, seal('{"api":"new-secret"}'))
    assert.equal(stored.encrypted_credentials.includes('new-secret'), false)
    assert.deepEqual((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots')).rows.map(row => row.user_id), [foreign])

    await pool.query(`UPDATE user_mcp_servers SET credential_slots='[]',encrypted_credentials='',credentials_nonce='',
      encrypted_credentials_key='',encrypted_headers=$2,headers_nonce='nonce',encrypted_headers_key='wrapped',headers_key_version=1 WHERE id=$1`,
      [serverId, seal('{"Authorization":"Bearer legacy-secret"}')])
    const legacy = await mutations.update(owner, serverId, {
      credential_slots: [{ id: 'legacy_header_0', label: 'Authorization', target: 'header', name: 'Authorization', prefix: '' }],
      credential_values: { legacy_header_0: 'Bearer legacy-secret' },
    })
    assert.deepEqual(legacy.credential_values, { legacy_header_0: 'Bearer legacy-secret' })
    const migrated = (await pool.query('SELECT encrypted_credentials,encrypted_headers FROM user_mcp_servers WHERE id=$1', [serverId])).rows[0]
    assert.equal(migrated.encrypted_credentials, seal('{"legacy_header_0":"Bearer legacy-secret"}'))
    assert.equal(migrated.encrypted_headers, '')

    await pool.query(`CREATE TABLE core_operation_receipts(owner_id uuid,operation_id uuid,fingerprint text,method text,
      result_json text,created_at timestamptz,PRIMARY KEY(owner_id,operation_id));
      CREATE TABLE users(id uuid,is_active boolean,account_status text,security_version integer);
      CREATE TABLE conversation_sessions(id integer,user_id uuid,active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence integer,lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz)`)
    await pool.query("INSERT INTO users VALUES($1,true,'active',1)", [owner])
    await pool.query("INSERT INTO conversation_sessions VALUES(17,$1,'synthetic-run')", [owner])
    await pool.query("INSERT INTO agent_run_dispatch VALUES($1,17,'synthetic-run','selected','token',1,clock_timestamp()+interval '2 minutes')", [owner])
    await pool.query("INSERT INTO agent_run_leases VALUES($1,17,'synthetic-run',clock_timestamp()+interval '2 minutes')", [owner])
    await pool.query('INSERT INTO user_mcp_tool_schema_snapshots VALUES($1,$2,$3,clock_timestamp())', [owner, 'cached', '[]'])
    const identity = { ownerId: owner, sessionId: '17', runId: 'synthetic-run' }
    const version = 'a'.repeat(64)
    let currentVersion = version
    const authority = createWebAgentConfirmationAuthorization({
      pool, lease: { identity, token: 'token', fence: 1, mode: 'start', cancelRequested: false,
        input: { userMessageId: 7, locale: null, origin: null, accessVersion: version, v: 2, source: 'web' } },
      accessVersion: async () => currentVersion,
    })
    const list = createMcpServerConfigLister(runtime.db)
    const callbacks: boolean[] = []
    const unusedConfirmation = { gate: { async prepare() { throw new Error('常规配置无需确认') } } } as ClientDeleteConfirmationPort
    const toggle = createMcpManagementEditOperations(runtime, {
      decrypt,
      update: { crypto, maxTools: 8, validateEndpoint: value => value, confirmation: unusedConfirmation },
      async authorize(tx, candidate, signal) { return (await authority.authorizeInTransaction(tx, candidate, signal))?.endsWith(`:${version}`) === true },
      async afterCommit(candidate, id, enabled) {
        assert.equal(candidate, owner)
        assert.equal(id, serverId)
        assert.equal((await list(owner))[0]?.enabled, enabled)
        assert.deepEqual((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots')).rows.map(row => row.user_id), [foreign])
        callbacks.push(enabled)
        if (enabled) return { ok: false, state: 'error', error: 'MCP server 认证失败' }
      },
    })
    const { tools } = createToolRegistry({ authorize: async () => true,
      tools: [createMcpManagementTool({ list, decrypt, enabled: () => true, state: () => ({ state: 'unloaded', loaded_tool_count: 0 }) }, undefined, toggle)] })
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行进程') } }
    const enable = { id: 'enable', name: 'manage_mcp_servers', input: { action: 'enable', server_name: 'weather-v2' } }
    assert.equal((await tools.dispatch(enable, { ...scope, identity: { ...identity, ownerId: foreign } })).kind, 'completed')
    assert.equal((await list(owner))[0]?.enabled, false)
    assert.deepEqual(callbacks, [])
    currentVersion = 'b'.repeat(64)
    const revoked = await tools.dispatch(enable, scope)
    assert.equal(revoked.kind === 'completed' && revoked.successful, false)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_operation_receipts')).rows[0].n, 0)
    currentVersion = version
    const enabled = await tools.dispatch(enable, scope)
    assert.equal(enabled.kind === 'completed' && enabled.mutated, true)
    assert.match(JSON.stringify(enabled), /MCP server 认证失败/)
    assert.doesNotMatch(JSON.stringify(enabled), /legacy-secret|encrypted_credentials|credential_values/)
    const disable = { id: 'disable', name: enable.name, input: { action: 'disable', server_id: serverId } }
    const disabled = await tools.dispatch(disable, scope)
    assert.equal(disabled.kind === 'completed' && disabled.mutated, true)
    const replay = await tools.dispatch(enable, scope)
    assert.equal(replay.kind === 'completed' && replay.mutated, false)
    assert.equal((await list(owner))[0]?.enabled, false)
    assert.equal((await list(owner))[0]?.encrypted_credentials, migrated.encrypted_credentials)
    assert.deepEqual(callbacks, [true, false])
    assert.deepEqual(await tools.reconcile(disable, { ...identity, roundId: scope.roundId }), { ...disabled, mutated: false })

    const edit = { id: 'edit', name: enable.name, input: { action: 'update', server_id: serverId, new_server_name: 'weather-v3', timeout_seconds: 45 } }
    await pool.query('INSERT INTO user_mcp_tool_schema_snapshots VALUES($1,$2,$3,clock_timestamp())', [owner, 'cached-again', '[]'])
    const edited = await tools.dispatch(edit, scope)
    assert.equal(edited.kind === 'completed' && edited.mutated, true)
    assert.match(JSON.stringify(edited), /weather-v3/)
    assert.doesNotMatch(JSON.stringify(edited), /new-secret|legacy-secret|credential_values/)
    assert.equal((await list(owner))[0]?.timeout_seconds, 45)
    assert.equal((await list(owner))[0]?.encrypted_credentials, migrated.encrypted_credentials)
    assert.deepEqual(await tools.reconcile(edit, { ...identity, roundId: scope.roundId }), { ...edited, mutated: false })
    assert.deepEqual(callbacks, [true, false, false])

    await assert.rejects(mutations.update(foreign, serverId, { enabled: true }), (error: unknown) => error instanceof CoreError && error.code === 'not_found')
    await assert.rejects(mutations.remove(foreign, serverId), (error: unknown) => error instanceof CoreError && error.code === 'not_found')
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_mcp_servers')).rows[0].count, 1)

    await pool.query('INSERT INTO user_mcp_tool_schema_snapshots VALUES($1,$2,$3,clock_timestamp())', [owner, 'before-delete', '[]'])
    assert.deepEqual(await mutations.remove(owner, serverId), { deleted: true, id: serverId })
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_mcp_servers')).rows[0].count, 0)
    assert.deepEqual((await pool.query('SELECT user_id FROM user_mcp_tool_schema_snapshots')).rows.map(row => row.user_id), [foreign])
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
  }
})
