import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { createMcpServerConfigLister } from '@gugu/core/mcp/server-list'
import { createNodeProviderTransport } from '@gugu/core/providers/node'
import { createKyselyScheduledTaskExecutionReader } from '@gugu/core/scheduled-task-run-now-read'
import { createMcpRuntime } from '../../src/modules/mcp/runtime.js'
import { createMcpSkillToolDirectory } from '../../src/modules/mcp/skill-tool-directory.js'
import { createWebScheduledTaskToolResources } from '../../src/modules/scheduled-tasks/run/tools.js'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('定时 MCP 经 SDK 执行，按任务及当前确认模式授权，并拒绝重放未知结果', { skip: !pgUrl && '需要隔离 PostgreSQL' }, async () => {
  const owner = randomUUID(), other = randomUUID(), serverId = randomUUID()
  const schema = `mcp_scheduled_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: pgUrl!, schema })
  let calls = 0
  let onToolsList: (() => Promise<void>) | undefined
  let unknown = false
  const server = createServer(async (request, reply) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
      if (body.method === 'notifications/initialized') { reply.writeHead(202).end(); return }
      let result
      if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'synthetic', version: '1' } }
      else if (body.method === 'tools/list') {
        await onToolsList?.()
        result = { tools: [{ name: 'ping', description: '合成查询', inputSchema: { type: 'object', properties: {} } }] }
      } else if (body.method === 'tools/call') {
        calls++
        if (unknown) { reply.destroy(); return }
        result = { content: [{ type: 'text', text: '合成 MCP 工具结果' }] }
      } else { reply.writeHead(404).end(); return }
      reply.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    } catch { reply.writeHead(500).end() }
  })
  const transport = () => {
    const client = createNodeProviderTransport({ allowLocal: true, trustEnvironment: false })
    return { request: (request: Parameters<typeof client.request>[0], signal: AbortSignal) =>
      client.request({ ...request, allowLocal: true }, signal), close: () => client.close() }
  }
  const configs = createMcpServerConfigLister(core.db)
  const common = { enabled: () => true, maxTools: 3, builtinNames: async () => new Set<string>(),
    decrypt: { async decrypt(): Promise<never> { throw new Error('合成 endpoint 不使用密文') } }, transport }
  const directory = createMcpSkillToolDirectory(core.db, common)
  const runtime = createMcpRuntime({ ...common, configs })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE scheduled_tasks (id int PRIMARY KEY,user_id uuid,enabled boolean,name text,payload text,
      channels text,delivery_targets jsonb,authorized_tools jsonb,email_attachment_file_ids jsonb,workspace_id int,
      filesystem_authorization_grant_id int,schedule_kind text,end_at timestamptz,last_run_failed boolean);
      CREATE TABLE user_mcp_servers(id uuid PRIMARY KEY,user_id uuid,scope text,name text,transport text,endpoint text,
        encrypted_endpoint text,endpoint_nonce text,encrypted_endpoint_key text,endpoint_key_version int,command text,credential_slots jsonb,
        encrypted_credentials text,credentials_nonce text,encrypted_credentials_key text,credentials_key_version int,
        encrypted_headers text,headers_nonce text,encrypted_headers_key text,headers_key_version int,encrypted_query_params text,
        query_params_nonce text,encrypted_query_params_key text,query_params_key_version int,enabled boolean,confirm_mode text,
        timeout_seconds int,tool_allowlist jsonb,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE user_mcp_tool_schema_snapshots(user_id uuid PRIMARY KEY,config_digest text,schemas jsonb,refreshed_at timestamptz)`)
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,enabled,name,channels,authorized_tools,schedule_kind)
      VALUES(1,$1,TRUE,'合成任务','web','[]','cron')`, [owner])
    await pool.query(`INSERT INTO user_mcp_servers(id,user_id,scope,name,transport,endpoint,enabled,confirm_mode,timeout_seconds,created_at,updated_at)
      VALUES($1,$2,'user','test','http',$3,TRUE,'auto',5,NOW(),NOW()),($4,$5,'user','foreign','http',$3,TRUE,'auto',5,NOW(),NOW())`,
    [serverId, owner, `http://127.0.0.1:${address.port}/mcp`, randomUUID(), other])
    const readTask = createKyselyScheduledTaskExecutionReader(core.db, 'postgres')
    const resources = createWebScheduledTaskToolResources({ core, now: () => new Date(), timezone: async () => 'UTC', mcp: { directory, runtime } })
    const signal = new AbortController().signal
    let held = true
    async function prepare() {
      const record = await readTask(owner, '1')
      assert.ok('plan' in record)
      const identity = { ownerId: owner, sessionId: 'scheduled-task:1', runId: randomUUID() }
      const { tools, preparation } = await resources({ identity, task: record.plan, async assertLease() {
        if (!held) throw new Error('失去合成租约')
      } })
      const names = (await preparation.discover(await preparation.configuration(identity, signal), signal)).map(tool => tool.name)
      const dispatch = (candidate = identity) => tools.dispatch({ id: 'read-synthetic', name: 'mcp_test_ping', input: {} }, {
        identity: candidate, roundId: '1', signal, resolution: null, async execute() { assert.fail('HTTP MCP 不启动宿主进程') },
      })
      return { names, dispatch, identity }
    }
    const automatic = await prepare()
    assert.ok(automatic.names.includes('mcp_test_ping'))
    assert.ok(!automatic.names.includes('mcp_foreign_ping'))
    assert.equal((await automatic.dispatch({ ...automatic.identity, ownerId: other })).kind, 'completed')
    assert.equal(calls, 0)
    // 握手期间升级确认要求。最终工具外呼必须重新读取配置，不能使用握手前的授权。
    onToolsList = async () => { await pool.query("UPDATE user_mcp_servers SET confirm_mode='confirm_all' WHERE id=$1", [serverId]) }
    const revokedMode = await automatic.dispatch()
    assert.ok(revokedMode.kind === 'completed' && !revokedMode.successful)
    assert.equal(calls, 0)
    onToolsList = undefined
    assert.ok(!(await prepare()).names.includes('mcp_test_ping'))
    await pool.query("UPDATE scheduled_tasks SET authorized_tools='[\"send_email\"]' WHERE id=1")
    assert.ok(!(await prepare()).names.includes('mcp_test_ping'))
    await pool.query("UPDATE scheduled_tasks SET authorized_tools='[\"mcp_test_ping\"]' WHERE id=1")
    const historical = await prepare()
    assert.ok(historical.names.includes('mcp_test_ping'))
    const approved = await historical.dispatch()
    assert.ok(approved.kind === 'completed' && approved.successful)
    assert.deepEqual(approved.value, { result: '合成 MCP 工具结果' })
    assert.equal(calls, 1)
    await pool.query("UPDATE scheduled_tasks SET authorized_tools='[]' WHERE id=1")
    await pool.query("UPDATE user_mcp_servers SET confirm_mode='auto' WHERE id=$1", [serverId])
    const revoked = await historical.dispatch()
    assert.ok(revoked.kind === 'completed' && !revoked.successful)
    assert.equal(calls, 1)
    const inFlight = await prepare()
    held = false
    const lost = await inFlight.dispatch()
    assert.ok(lost.kind === 'completed' && !lost.successful)
    assert.equal(calls, 1)
    held = true
    await runtime.invalidate(owner, serverId)
    onToolsList = async () => { held = false }
    const lostDuringHandshake = await inFlight.dispatch()
    assert.ok(lostDuringHandshake.kind === 'completed' && !lostDuringHandshake.successful)
    assert.equal(calls, 1)
    onToolsList = undefined
    held = true
    unknown = true
    assert.deepEqual(await inFlight.dispatch(), { kind: 'unknown' })
    assert.equal(calls, 2)
  } finally {
    await runtime.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end() }
  }
})
