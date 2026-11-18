import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import type { ConfirmationTargetSnapshot } from '../../../src/agent/tools/confirmation.js'
import type { ClientDeleteConfirmationPort } from '../../../src/agent/tools/clients.js'
import type { ToolCall } from '../../../src/agent/models.js'
import { expect, it, vi } from 'vitest'
import { createMcpManagementTool, createMcpManagementRemoveOperations, createMcpManagementEditOperations } from '../../../src/agent/tools/mcp-management.js'
import { createMcpServerConfigLister } from '../../../src/mcp/server-list.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { McpStoredServer } from '../../../src/mcp/server-list.js'

it('仅列认证 owner 的 MCP 安全投影并拒绝配置写入，任何凭据都不进入回执', async () => {
  const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
  const row = {
    id: 'synthetic-id', name: '示例', scope: 'user', transport: 'http', endpoint: '',
    encrypted_endpoint: '隐藏端点', endpoint_nonce: '隐藏端点', encrypted_endpoint_key: '隐藏端点', endpoint_key_version: 1,
    encrypted_credentials: '隐藏凭据密文', encrypted_headers: '隐藏凭据密文', encrypted_query_params: '',
    command: '不返回命令或参数', credential_slots: [{ id: 'auth', target: 'header', name: 'Authorization',
      label: '服务身份', value: '隐藏明文', prefix: '隐藏前缀' }],
    enabled: true, confirm_mode: 'confirm_all', timeout_seconds: 30, tool_allowlist: ['lookup'], created_at: '2026-01-01',
  } as McpStoredServer
  const list = vi.fn(async (_owner: string) => [row])
  const decrypt = vi.fn(async () => 'https://synthetic:password@example.invalid/隐藏路径?key=token#fragment')
  const tool = createMcpManagementTool({ list, decrypt, enabled: () => true, state: () => ({
    state: 'ok', loaded_tool_count: 1, loaded_tool_names: ['lookup'], last_error: '隐藏上游错误',
  }) })
  const registry = createToolRegistry({ tools: [tool], authorize: async actor => actor.ownerId === identity.ownerId })
  const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('列表无需执行进程') } }
  const call = { id: 'list', name: 'manage_mcp_servers', input: { action: 'list' } }
  expect(await registry.tools.dispatch({ ...call, input: { action: 'remove' } }, scope)).toMatchObject({ successful: false, executed: false })
  expect(await registry.tools.dispatch(call, { ...scope, identity: { ...identity, ownerId: '他人' } })).toMatchObject({ successful: false })
  const result = await registry.tools.dispatch(call, scope)
  expect(list).toHaveBeenCalledExactlyOnceWith(identity.ownerId)
  expect(decrypt).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ successful: true, mutated: false, value: { enabled: true, items: [{
    endpoint: 'https://example.invalid', enabled: true, loaded_tool_names: ['lookup'],
    credential_slots: [{ id: 'auth', target: 'header', name: 'Authorization', label: '服务身份' }],
    credential_state: { configured: true, slot_ids: ['auth'] },
  }] } })
  expect(JSON.stringify(result)).not.toMatch(/隐藏|token|password|fragment|命令|credential_values/)
})

it('连接测试绑定当前 owner 的 UUID 或名称，遵守停用和取消，有界投影结果', async () => {
  const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
  const id = '00000000-0000-4000-8000-000000000007'
  const list = vi.fn(async () => [{ id, name: '地图', scope: 'user' }] as McpStoredServer[])
  const probe = vi.fn<NonNullable<Parameters<typeof createMcpManagementTool>[0]['testConnection']>>()
    .mockResolvedValue({ ok: true, toolNames: ['mcp_map_z', 'mcp_map_a'] })
  let enabled = true
  const tool = createMcpManagementTool({ list, decrypt: async () => '', enabled: () => enabled,
    state: () => ({ state: 'unloaded', loaded_tool_count: 0 }), testConnection: probe })
  const registry = createToolRegistry({ tools: [tool], authorize: async candidate => candidate.ownerId === identity.ownerId })
  const controller = new AbortController()
  const scope = { identity, roundId: 'round', signal: controller.signal, resolution: null,
    execute: async () => { throw new Error('探测无需执行进程') } }
  const call = { id: 'test', name: 'manage_mcp_servers', input: { action: 'test_connection', server_name: '地图' } }
  expect(await registry.tools.dispatch(call, { ...scope, identity: { ...identity, ownerId: '他人' } })).toMatchObject({ successful: false })
  expect(await registry.tools.dispatch({ ...call, input: { ...call.input, server_id: '不合法' } }, scope))
    .toMatchObject({ successful: false, value: { error: 'MCP server id 无效' } })
  expect(await registry.tools.dispatch({ ...call, input: { ...call.input, server_name: '不存在' } }, scope))
    .toMatchObject({ successful: false, value: { error: 'MCP server 不存在或不属于当前账号' } })
  enabled = false
  expect(await registry.tools.dispatch(call, scope)).toMatchObject({ successful: false, value: { ok: false, tools: [], error_kind: null } })
  expect(probe).not.toHaveBeenCalled()
  enabled = true
  expect(await registry.tools.dispatch(call, scope)).toMatchObject({ successful: true, mutated: false,
    value: { ok: true, tool_count: 2, tools: ['mcp_map_a', 'mcp_map_z'], message: '连接成功。' } })
  expect(probe).toHaveBeenCalledExactlyOnceWith(identity.ownerId, id, controller.signal)
  probe.mockResolvedValueOnce({ ok: false, errorKind: 'auth' })
  expect(await registry.tools.dispatch(call, scope)).toMatchObject({ successful: false, mutated: false,
    value: { ok: false, tool_count: 0, tools: [], error_kind: 'auth', retryable: false } })
  probe.mockImplementationOnce(async () => { controller.abort(); return { ok: true, toolNames: ['不应投影'] } })
  // 查询已经取消，后续响应不得作为成功回执发布。
  await expect(registry.tools.dispatch(call, scope)).rejects.toMatchObject({ name: 'AbortError' })
})

it('SQLite 启停保留旧连接配置，提交后失效且不重放副作用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-mcp-toggle-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  const id = '00000000-0000-4000-8000-000000000009'
  const ownerKey = ownerId.replaceAll('-', '')
  try {
    await sql`INSERT INTO user_mcp_servers(id,user_id,scope,name,endpoint,created_at,updated_at)
      VALUES (${id},${ownerKey},'user','旧服务','https://example.invalid/private?key=legacy-secret','2026-01-01','2026-01-01')`.execute(runtime.db)
    const list = createMcpServerConfigLister(runtime.db, runtime.backend)
    const decrypt = async () => { throw new Error('旧端点不需要解密') }
    const afterCommit = vi.fn(async () => {})
    const toggle = createMcpManagementEditOperations(runtime, { decrypt, authorize: async () => true, afterCommit })
    const { tools } = createToolRegistry({ authorize: async () => true,
      tools: [createMcpManagementTool({ list, decrypt, enabled: () => true, state: () => ({ state: 'unloaded', loaded_tool_count: 0 }) }, undefined, toggle)] })
    const identity = { ownerId, sessionId: '1', runId: 'mcp-toggle' }
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行进程') } }
    const call = { id: 'toggle', name: 'manage_mcp_servers', input: { action: 'disable', server_name: '旧服务' } }
    const result = await tools.dispatch(call, scope)
    expect(result).toMatchObject({ successful: true, mutated: true, value: { success: true, server: { enabled: false, endpoint: 'https://example.invalid' } } })
    expect(JSON.stringify(result)).not.toContain('legacy-secret')
    expect((await list(ownerId))[0]).toMatchObject({ enabled: 0, endpoint: 'https://example.invalid/private?key=legacy-secret' })
    expect(await tools.dispatch({ ...call, input: { ...call.input, action: 'enable' } }, scope)).toMatchObject({ successful: false, mutated: false })
    expect(await tools.reconcile(call, { ...identity, roundId: scope.roundId })).toEqual({ ...result, mutated: false })
    expect(afterCommit).toHaveBeenCalledTimes(1)
    const controller = new AbortController()
    afterCommit.mockImplementationOnce(async () => {
      controller.abort()
      return new Promise<void>(() => {})
    })
    const enable = { ...call, id: 'enable-after-disable', input: { ...call.input, action: 'enable' } }
    expect(await tools.dispatch(enable, { ...scope, signal: controller.signal }))
      .toMatchObject({ successful: true, mutated: true, value: { success: true, server: { enabled: true } } })
    expect((await list(ownerId))[0]?.enabled).toBe(1)
    expect(await tools.dispatch(enable, scope)).toMatchObject({ successful: true, mutated: false })
    expect(afterCommit).toHaveBeenCalledTimes(2)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('MCP 连接地址修改绑定确认时的目标版本，拒绝改投凭据和未提交重放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-mcp-update-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  const id = '00000000-0000-4000-8000-00000000000a'
  const ownerKey = ownerId.replaceAll('-', '')
  const list = createMcpServerConfigLister(runtime.db, runtime.backend)
  const decrypt = async (envelope: { ciphertext: string }) => Buffer.from(envelope.ciphertext, 'base64').toString()
  const afterCommit = vi.fn(async () => {})
  let proposal: ConfirmationTargetSnapshot | undefined, failSeal = false
  const gate = {
    async prepare(toolCall: ToolCall, _scope: unknown, _hash: string, snapshot: ConfirmationTargetSnapshot) {
      proposal = snapshot
      return { ok: true, value: { id: 'confirm', kind: 'confirmation', toolCall } }
    },
    async verify(_call: unknown, _scope: unknown, _hash: string, snapshot: ConfirmationTargetSnapshot) {
      return snapshot.versionsDigest === proposal?.versionsDigest ? { ok: true, value: {} } : { ok: false }
    },
  } as unknown as ClientDeleteConfirmationPort['gate']
  const operations = createMcpManagementEditOperations(runtime, { decrypt, authorize: async () => true, afterCommit,
    update: { maxTools: 5, validateEndpoint: value => value, crypto: { decrypt, async encrypt(endpoint) {
      if (failSeal) throw new Error('合成密封失败')
      return { ciphertext: Buffer.from(endpoint).toString('base64'), nonce: 'nonce', encryptedDataKey: 'key', keyVersion: 1 }
    } }, confirmation: { gate, async claim(tx) {
      await sql`INSERT INTO synthetic_claims VALUES ('claimed')`.execute(tx)
      return true
    } } },
  })
  const { tools } = createToolRegistry({ authorize: async () => true,
    tools: [createMcpManagementTool({ list, decrypt, enabled: () => true, state: () => ({ state: 'unloaded', loaded_tool_count: 0 }) }, undefined, operations)] })
  const identity = { ownerId, sessionId: '1', runId: 'update' }
  const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应执行进程') } }
  const call = { id: 'update', name: 'manage_mcp_servers', input: { action: 'update', server_id: id, endpoint: 'https://example.invalid/new' } }
  const confirmed = { ...scope, resolution: { interactionId: 'confirm', receiptId: 'receipt', status: 'confirmed' as const, value: null } }
  try {
    await sql`CREATE TABLE synthetic_claims(id TEXT PRIMARY KEY)`.execute(runtime.db)
    await sql`INSERT INTO user_mcp_servers(id,user_id,scope,name,endpoint,created_at,updated_at)
      VALUES (${id},${ownerKey},'user','旧服务','https://old.invalid/rpc','2026-01-01','2026-01-01')`.execute(runtime.db)
    const credential = await tools.dispatch({ ...call, input: { ...call.input, credential_slots: [] } }, scope)
    expect(credential).toMatchObject({ successful: false, executed: false })
    expect(await tools.dispatch({ ...call, input: { ...call.input, endpoint: 'https://example.invalid/new?key=secret' } }, scope))
      .toMatchObject({ successful: false, value: { error: 'MCP 地址不得包含凭据、查询参数或片段' } })
    expect((await tools.dispatch(call, scope)).kind).toBe('waiting')
    await sql`UPDATE user_mcp_servers SET encrypted_credentials='existing' WHERE id=${id}`.execute(runtime.db)
    expect(await tools.dispatch(call, confirmed)).toMatchObject({ successful: false, mutated: false })
    await sql`UPDATE user_mcp_servers SET encrypted_credentials='',updated_at='2026-02-01' WHERE id=${id}`.execute(runtime.db)
    expect(await tools.dispatch(call, confirmed)).toMatchObject({ successful: false, mutated: false })
    expect((await tools.dispatch(call, scope)).kind).toBe('waiting')
    expect(proposal?.displaySummary).toContain('https://example.invalid')
    expect(proposal?.displaySummary).not.toContain('/new')
    failSeal = true
    expect((await tools.dispatch(call, confirmed)).kind).toBe('unknown')
    expect((await sql`SELECT id FROM synthetic_claims`.execute(runtime.db)).rows).toEqual([])
    failSeal = false
    const result = await tools.dispatch(call, confirmed)
    expect(result).toMatchObject({ successful: true, mutated: true, value: { server: { endpoint: 'https://example.invalid' } } })
    expect(JSON.stringify(result)).not.toContain('/new')
    expect((await list(ownerId))[0]?.endpoint).toBe('')
    expect((await sql`SELECT id FROM synthetic_claims`.execute(runtime.db)).rows).toEqual([{ id: 'claimed' }])
    expect(await tools.dispatch(call, confirmed)).toMatchObject({ successful: true, mutated: false })
    expect(afterCommit).toHaveBeenCalledTimes(1)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('MCP 删除按名称确认 UUID 和版本，借用确认事务并清除持久声明，重放只读收据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-mcp-remove-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  const first = '00000000-0000-4000-8000-000000000001'
  const second = '00000000-0000-4000-8000-000000000002'
  const ownerKey = ownerId.replaceAll('-', '')
  const events: string[][] = []
  let target: ConfirmationTargetSnapshot | undefined
  let claimed = 0, blockClaim = false
  const gate = {
    async prepare(toolCall: ToolCall, _scope: unknown, _hash: string, snapshot: ConfirmationTargetSnapshot) {
      target = snapshot
      return { ok: true, value: { id: 'confirmation', kind: 'confirmation', toolCall } }
    },
    async verify(_call: unknown, _scope: unknown, _hash: string, snapshot: ConfirmationTargetSnapshot) {
      if (snapshot.targetsDigest !== target?.targetsDigest || snapshot.versionsDigest !== target?.versionsDigest) return { ok: false }
      return { ok: true, value: {} }
    },
  } as unknown as ClientDeleteConfirmationPort['gate']
  const read = async (table: 'user_mcp_servers' | 'user_mcp_tool_schema_snapshots' | 'confirmation_claims') =>
    (await sql<{ id: string }>`SELECT ${sql.ref(table === 'user_mcp_tool_schema_snapshots' ? 'user_id' : 'id')} AS id
      FROM ${sql.table(table)} ORDER BY id`.execute(runtime.db)).rows.map(row => row.id)
  try {
    await sql`CREATE TABLE confirmation_claims(id TEXT PRIMARY KEY)`.execute(runtime.db)
    await sql`INSERT INTO user_mcp_servers(id,user_id,scope,name,created_at,updated_at)
      VALUES (${first},${ownerKey},'user','同名','2026-01-01','2026-01-01'),(${second},${ownerKey},'system','同名','2026-01-01','2026-01-01')`.execute(runtime.db)
    await sql`INSERT INTO user_mcp_tool_schema_snapshots(user_id,config_digest,refreshed_at)
      VALUES (${ownerKey},'current','2026-01-01')`.execute(runtime.db)
    const crypto = {
      async encrypt() { throw new Error('删除无需解密或加密') },
      async decrypt() { throw new Error('删除无需解密或加密') },
    }
    const remove = createMcpManagementRemoveOperations(runtime, { crypto, maxTools: 4 }, {
      confirmation: { gate, async claim(tx) {
        claimed++
        await sql`INSERT INTO confirmation_claims VALUES ('confirmed')`.execute(tx)
        return !blockClaim
      } },
      async invalidate(owner, server) { events.push([owner, server]) },
    })
    const tool = createMcpManagementTool({ list: async () => [], decrypt: crypto.decrypt, enabled: () => true,
      state: () => ({ state: 'unloaded', loaded_tool_count: 0 }) }, remove)
    const registry = createToolRegistry({ tools: [tool], authorize: async identity => ownerId === identity.ownerId })
    const call = { id: 'delete', name: 'manage_mcp_servers', input: { action: 'remove', server_name: ' 同名 ' } }
    const scope = { identity: { ownerId, sessionId: '1', runId: 'mcp' }, roundId: 'mcp:1',
      signal: new AbortController().signal, resolution: null, execute: async () => { throw new Error('不应连接外部服务') } }
    const resolution = { interactionId: 'confirmation', receiptId: 'receipt', status: 'confirmed' as const, value: null }
    expect(await registry.tools.dispatch({ ...call, input: { action: 'remove', server_id: second } } as ToolCall, scope))
      .toMatchObject({ successful: false, mutated: false })
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ kind: 'waiting' })
    expect(target?.targetRefs).toEqual({ mcp_server: [first] })
    expect(await read('user_mcp_servers')).toEqual([first, second])
    await sql`UPDATE user_mcp_servers SET updated_at='2026-01-02' WHERE id=${first}`.execute(runtime.db)
    expect(await registry.tools.dispatch(call, { ...scope, resolution })).toMatchObject({ successful: false, mutated: false })
    expect(claimed).toBe(0)
    expect(await registry.tools.dispatch(call, scope)).toMatchObject({ kind: 'waiting' })
    blockClaim = true
    expect(await registry.tools.dispatch(call, { ...scope, resolution })).toMatchObject({ successful: false })
    expect(await read('confirmation_claims')).toEqual([])
    blockClaim = false
    expect(await registry.tools.dispatch(call, { ...scope, resolution })).toMatchObject({
      successful: true, mutated: true, value: { success: true, server_id: first },
    })
    expect(await read('user_mcp_servers')).toEqual([second])
    expect(await read('user_mcp_tool_schema_snapshots')).toEqual([])
    expect(await read('confirmation_claims')).toEqual(['confirmed'])
    expect(await registry.tools.dispatch(call, { ...scope, resolution })).toMatchObject({ successful: true, mutated: false })
    expect(events).toEqual([[ownerId, first]])
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
