import { createHash } from 'node:crypto'
import { CoreError, dataContext } from '../../../contracts/index.js'
import type { SqlDataRuntime } from '../../../data/runtime.js'
import type { Database } from '../../../data/schema.js'
import type { Transaction } from 'kysely'
import type { Json, PendingInteraction, RunIdentity, ToolCall, ToolResult } from '../../models.js'
import { stableJson } from '../../context/history/canonical-history.js'
import { cancellable } from '../../run/cancellation.js'
import type { ClientDeleteConfirmationPort } from '../clients/index.js'
import { z } from 'zod'
import { createMcpServerConfigLister, type McpStoredServer } from '../../../mcp/server-list.js'
import { createMcpServerMutations, setMcpServerEnabled, type McpEnvelopeCrypto, type McpServerPatch } from '../../../mcp/server-mutations.js'
import { normalizeMcpServerName, normalizeMcpSlots, validateMcpCommon } from '../../../mcp/server-config.js'
import { createMcpServerCreator, type McpServerCreateInput } from '../../../mcp/server-create.js'
import type { ToolDefinition, ToolScope } from '../contracts.js'
import { normalizeToolInput } from '../normalize-input.js'

interface McpManagementServerState {
  state: string
  loaded_tool_count: number
  loaded_tool_names?: string[]
}

export interface AgentMcpManagementListPorts {
  list(ownerId: string): Promise<readonly McpStoredServer[]>
  decrypt: McpEnvelopeCrypto['decrypt']
  enabled(): boolean
  testConnection?(ownerId: string, id: string, signal: AbortSignal): Promise<AgentMcpConnectionResult>
  state?(ownerId: string, id: string): McpManagementServerState | Promise<McpManagementServerState>
}

type ConnectionErrorKind = 'configuration' | 'auth' | 'timeout' | 'network' | 'protocol'
type AgentMcpConnectionResult = { ok: true; toolNames: readonly string[] }
  | { ok: false; errorKind: ConnectionErrorKind | null }

const connectionErrors: Record<ConnectionErrorKind, { error: string; retryable: boolean; next_action: string }> = {
  configuration: { error: 'MCP 配置无效或缺少凭据', retryable: false, next_action: '修正 MCP endpoint 或凭据配置后再测试。' },
  auth: { error: 'MCP server 认证失败', retryable: false, next_action: '核对服务要求的凭据名称、前缀和密钥值后再测试。' },
  timeout: { error: '连接 MCP server 超时', retryable: true, next_action: '确认服务和网络恢复后再重试。' },
  network: { error: '无法连接 MCP server', retryable: true, next_action: '确认服务和网络恢复后再重试。' },
  protocol: { error: 'MCP 服务返回无效响应', retryable: false, next_action: '检查 MCP 服务返回的协议错误，再决定是否修改配置。' },
}

function endpointView(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { endpoint: '', hasCredentials: false }
    return { endpoint: url.origin, hasCredentials: Boolean(url.username || url.password)
      || Array.from(url.searchParams.values()).some(item => !item.includes('{{secret:')) }
  } catch {
    return { endpoint: '', hasCredentials: false }
  }
}

function slotDefinitions(raw: unknown) {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const { id, label, target, parameter_name, name } = entry as Record<string, unknown>
    const parameter = parameter_name ?? name
    if (typeof id !== 'string' || typeof parameter !== 'string' || (target !== 'header' && target !== 'query')) return []
    return [{ id, label: typeof label === 'string' ? label : id, target, name: parameter }]
  })
}

async function safeServerView(row: Omit<McpStoredServer, 'updated_at'>, decrypt: McpEnvelopeCrypto['decrypt'], signal: AbortSignal) {
  let endpoint = row.endpoint
  if (row.encrypted_endpoint) {
    try {
      endpoint = await decrypt({ ciphertext: row.encrypted_endpoint, nonce: row.endpoint_nonce,
        encryptedDataKey: row.encrypted_endpoint_key, keyVersion: row.endpoint_key_version })
    } catch {
      endpoint = ''
    }
  }
  signal.throwIfAborted()
  const view = endpointView(endpoint)
  const slots = slotDefinitions(row.credential_slots)
  return {
    id: row.id, name: row.name, scope: row.scope, transport: row.transport, endpoint: view.endpoint,
    credential_slots: slots, credential_state: {
      configured: Boolean(row.encrypted_credentials || row.encrypted_headers || row.encrypted_query_params || view.hasCredentials),
      slot_ids: slots.map(slot => slot.id),
    },
    enabled: Boolean(row.enabled), confirm_mode: row.confirm_mode, timeout_seconds: row.timeout_seconds,
    tool_allowlist: Array.isArray(row.tool_allowlist) ? row.tool_allowlist : [],
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

const schema = z.object({ action: z.literal('list') }).strict()

/** 按 Host 装配开放安全配置投影、连接刷新及持久确认删除。 */
export function createMcpManagementTool(
  ports: AgentMcpManagementListPorts,
  remove?: ReturnType<typeof createMcpManagementRemoveOperations>,
  edit?: ReturnType<typeof createMcpManagementEditOperations>,
  add?: ReturnType<typeof createMcpManagementCreateOperations>,
): ToolDefinition {
  const inputSchema = z.union([schema, ...(ports.testConnection ? [connectionSchema] : []), ...(remove ? [removalSchema] : []),
    ...(edit ? [toggleSchema] : []), ...(edit?.updates ? [edit.credentials ? updateSchema : updateSchema.omit({ credential_slots: true })] : []),
    ...(add ? [add.credentials ? addSchema : addSchema.omit({ credential_slots: true })] : [])])
  const credentials = add?.credentials || edit?.credentials
  const actions = ['list', ...(ports.testConnection ? ['test_connection'] : []), ...(remove ? ['remove'] : []),
    ...(edit ? ['enable', 'disable'] : []), ...(edit?.updates ? ['update'] : []), ...(add ? ['add'] : [])]
  return {
    definition: { name: 'manage_mcp_servers', schema: { type: 'function', function: {
      name: 'manage_mcp_servers', description: [
        '列出当前账号的 MCP 服务配置和已知连接状态。',
        ...(ports.testConnection ? ['test_connection 按 server_id 或 server_name 重新检查已保存的连接。'] : []),
        ...(remove ? ['remove 删除服务，需用户确认。'] : []),
        ...(edit ? ['enable 和 disable 更改已保存服务的启用状态。'] : []),
        ...(edit?.updates ? ['update 修改名称、HTTP 地址和运行配置。修改地址、工具白名单或切换至自动确认时需要确认。'] : []),
        ...(add ? ['add 使用 server_name 和 endpoint 添加公网 HTTP 服务，需用户确认。'] : []),
        ...(credentials ? ['添加或更换 Header 凭据槽位后，用户通过私密表单填写凭据值。'] : []),
        ...(edit?.credentials ? ['更换槽位需确认并清除旧凭据，空数组表示移除全部槽位。'] : []),
      ].join(''),
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: actions },
        ...(actions.length > 1 ? { server_id: { type: 'string', maxLength: 64 }, server_name: { type: 'string', maxLength: 64 } } : {}),
        ...(edit?.updates ? { new_server_name: { type: 'string', maxLength: 64 } } : {}),
        ...(edit?.updates || add ? {
          transport: { type: 'string', enum: ['http'] },
          endpoint: { type: 'string', maxLength: 1000 }, enabled: { type: 'boolean' },
          confirm_mode: { type: 'string', enum: ['auto', 'confirm_all'] },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 300 },
          tool_allowlist: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 128 } },
        } : {}),
        ...(credentials ? { credential_slots: { type: 'array', maxItems: 16, items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'label', 'target', 'parameter_name'],
          properties: {
            id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
            label: { type: 'string', maxLength: 120 }, target: { type: 'string', enum: ['header'] },
            parameter_name: { type: 'string', maxLength: 256 }, prefix: { type: 'string', maxLength: 120 },
          },
        } } } : {}),
      }, required: ['action'], additionalProperties: false },
    } } },
    effect: remove || edit || add ? 'write' : 'read',
    effectForInput(input) {
      const { action } = input as z.infer<typeof inputSchema>
      return action === 'list' || action === 'test_connection' ? 'read' : 'write'
    },
    ...(remove || edit?.updates || add ? { requiresInteraction: true, confirmationReplay: true } : {}),
    ...(remove || edit || add ? {
      reconcile(input: unknown, identity: RunIdentity & { roundId: string }, call: ToolCall) {
        const args = input as z.infer<typeof inputSchema>
        if (remove && args.action === 'remove') return remove.reconcile(args, identity, identity.roundId, call.id)
        if (add && args.action === 'add') return add.reconcile(args, identity, identity.roundId, call)
        if (edit && (args.action === 'enable' || args.action === 'disable' || args.action === 'update'))
          return edit.reconcile(args, identity, identity.roundId, call)
        return Promise.resolve({ kind: 'unknown' as const })
      },
    } : {}),
    validate: input => inputSchema.safeParse(input),
    async execute(input, scope, call) {
      const args = input as z.infer<typeof inputSchema>
      if (remove && args.action === 'remove') return remove.execute(args, scope, call)
      if (add && args.action === 'add') return add.execute(args, scope, call)
      if (edit && (args.action === 'enable' || args.action === 'disable' || args.action === 'update')) return edit.execute(args, scope, call)
      if (scope.resolution) return queryFailure('该操作不接受确认回执')
      const ownerId = scope.identity.ownerId
      if (args.action === 'test_connection' && ports.testConnection) {
        const target = normalizedSelector(args)
        if (target.server_id && !mcpUuid.test(target.server_id)) return queryFailure('MCP server id 无效')
        if (!target.server_id && !target.server_name) return queryFailure('需要提供 server_id 或 server_name')
        const rows = await ports.list(ownerId)
        scope.signal.throwIfAborted()
        const row = rows.find(row => row.scope === 'user' && (target.server_id ? row.id === target.server_id : row.name === target.server_name))
        if (!row) return queryFailure('MCP server 不存在或不属于当前账号')
        const result = ports.enabled()
          ? await cancellable(ports.testConnection(ownerId, row.id, scope.signal), scope.signal)
          : { ok: false as const, errorKind: null }
        scope.signal.throwIfAborted()
        if (result.ok) {
          const tools = [...result.toolNames].sort()
          return { kind: 'completed', successful: true, mutated: false, value: {
            ok: true, tool_count: tools.length, tools, error: null, error_kind: null, retryable: false, next_action: null, message: '连接成功。',
          } }
        }
        const failure = result.errorKind && connectionErrors[result.errorKind]
        return { kind: 'completed', successful: false, mutated: false, value: {
          ok: false, tool_count: 0, tools: [], error_kind: result.errorKind, retryable: false, error: null, next_action: null, ...failure, message: null,
        } }
      }
      const rows = await ports.list(ownerId)
      const items = []
      for (const row of rows) {
        scope.signal.throwIfAborted()
        const server = await safeServerView(row, ports.decrypt, scope.signal)
        const state = await ports.state?.(ownerId, row.id) ?? {
          state: row.enabled ? 'unloaded' : 'disabled', loaded_tool_count: 0, loaded_tool_names: [],
        }
        scope.signal.throwIfAborted()
        items.push({ ...server, state: state.state, loaded_tool_count: state.loaded_tool_count, loaded_tool_names: state.loaded_tool_names ?? [] })
      }
      return { kind: 'completed', successful: true, mutated: false, value: { enabled: ports.enabled(), items } }
    },
  }
}

export interface McpManagementRemoveOptions {
  confirmation: ClientDeleteConfirmationPort
  invalidate(ownerId: string, serverId: string): Promise<unknown>
}

const selector = z.object({
  server_id: z.string().max(64).optional(),
  server_name: z.string().max(64).optional(),
}).strict()
const mcpUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const removalSchema = selector.extend({ action: z.literal('remove') })
const connectionSchema = selector.extend({ action: z.literal('test_connection') })
const toggleSchema = selector.extend({ action: z.enum(['enable', 'disable']) })
const configurable = {
  transport: z.literal('http').optional(), enabled: z.boolean().optional(),
  confirm_mode: z.enum(['auto', 'confirm_all']).optional(), timeout_seconds: z.number().int().min(1).max(300).optional(),
  tool_allowlist: z.array(z.string().min(1).max(128)).max(32).optional(),
}
const credentialSlotsSchema = z.array(z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u), label: z.string().min(1).max(120),
  target: z.literal('header'), parameter_name: z.string().min(1).max(256),
  prefix: z.string().max(120).regex(/^[\x20-\x7e]*$/u).optional(),
})).max(16).optional()
const updateSchema = selector.extend({
  ...configurable, action: z.literal('update'), new_server_name: z.string().min(1).max(64).optional(),
  endpoint: z.string().min(1).max(1000).optional(), credential_slots: credentialSlotsSchema,
})
const addSchema = z.strictObject({
  ...configurable, action: z.literal('add'), server_name: z.string().min(1).max(64),
  endpoint: z.string().min(1).max(1000),
  credential_slots: credentialSlotsSchema,
})
type RemovalInput = z.infer<typeof removalSchema>
type EditInput = z.infer<typeof toggleSchema> | z.infer<typeof updateSchema>
type AddInput = z.infer<typeof addSchema>

// 交互保留模型的原始工具调用，重建确认卡时需要与执行入口做相同的参数规范化。
const mcpAddInput = { name: 'manage_mcp_servers', schema: { input_schema: z.toJSONSchema(addSchema) as Json } }
const mcpUpdateInput = { name: 'manage_mcp_servers', schema: { input_schema: z.toJSONSchema(updateSchema) as Json } }

function queryFailure(error: string): ToolResult {
  return { kind: 'completed', successful: false, mutated: false, value: { error } }
}

function digest(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function operationKey(identity: RunIdentity, roundId: string, toolCallId: string, namespace: 'remove' | 'toggle' | 'update' | 'add') {
  const context = dataContext(identity.ownerId)
  const hex = digest([`agent.mcp.${namespace}`, context.ownerId, identity.sessionId, identity.runId, roundId, toolCallId])
  const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  return { context, operationId }
}

function agentEndpoint(raw: string, validate: (endpoint: string) => string) {
  let endpoint: string, url: URL
  try {
    const value = raw.trim()
    const link = /^\[([^\]\r\n]+)\]\((https?:\/\/[^\s()]+)\)$/iu.exec(value)
    endpoint = validate(link && link[1] === link[2] ? link[2]! : value)
    url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
  } catch {
    throw new CoreError('invalid_request', 'MCP 公网 HTTP 地址无效')
  }
  if (url.username || url.password || url.search || url.hash)
    throw new CoreError('invalid_request', 'MCP 地址不得包含凭据、查询参数或片段')
  return endpoint
}

function normalizedSelector(input: z.infer<typeof selector>) {
  const id = input.server_id?.trim().toLowerCase()
  return { server_id: id || null, server_name: id ? null : (input.server_name?.trim() || null) }
}

function versionOf(row: McpStoredServer) {
  // 保留 PostgreSQL 的微秒版本，正文只用于摘要，不进入可见结果。
  return digest({ ...row, created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at })
}

type StageMcpCredential = (tx: Transaction<Database>, identity: RunIdentity, request: PendingInteraction, serverId: string) => Promise<void>

function configurationResult(receipt: { credentialRequestId?: string }, call: ToolCall, mutated: boolean): ToolResult {
  return receipt.credentialRequestId
    ? { kind: 'waiting', interaction: { id: receipt.credentialRequestId, kind: 'credential', toolCall: call } }
    : { kind: 'completed', successful: true, mutated, value: receipt }
}

function describeMcpAdd(name: string, endpoint: string, enabled: boolean, mode: string, hasCredentialSlots: boolean) {
  return `将添加 MCP 服务「${name}」（${new URL(endpoint).origin}），${enabled ? '启用' : '停用'}，${mode === 'auto' ? '允许自动确认' : '每次调用均需确认'}${hasCredentialSlots ? '。确认后通过私密表单填写 Header 凭据' : ''}`
}

/** 新建提交借用与确认认领和持久收据相同的事务。 */
export function createMcpManagementCreateOperations(runtime: SqlDataRuntime, ports: {
  settings(): { default_timeout_seconds: number; max_tools_per_server: number; max_servers_per_user: number | null }
  id(): string
  encrypt: McpEnvelopeCrypto['encrypt']
  validateEndpoint(endpoint: string): string
  confirmation: ClientDeleteConfirmationPort
  authorize(tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  stageCredential?: StageMcpCredential
}) {
  if (!runtime.receipts) throw new Error('MCP 创建需要持久操作收据')
  const method = 'agent.mcp.add'
  const noReceipt = new Error('MCP 创建收据不存在')
  const stale = new Error('MCP 创建确认已失效')
  const creatorOptions = { id: ports.id, encrypt: ports.encrypt, maxServersPerUser: () => ports.settings().max_servers_per_user }
  const create = createMcpServerCreator(runtime.db, creatorOptions, runtime.backend)
  type Receipt = { success: true; server: Record<string, unknown>; credentialRequestId?: string }
  async function reconcile(input: AddInput, identity: RunIdentity, roundId: string, call: ToolCall): Promise<ToolResult> {
    const key = operationKey(identity, roundId, call.id, 'add')
    try {
      const { result } = await runtime.operationWithTransaction<Receipt>(key.context, key.operationId, method, input, async () => { throw noReceipt })
      return configurationResult(result, call, false)
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return queryFailure(error.message)
      return { kind: 'unknown' }
    }
  }
  return { credentials: Boolean(ports.stageCredential), reconcile, describe(identity: RunIdentity, input: unknown,
    snapshot: { targetsDigest: string }) {
    const parsed = addSchema.safeParse(normalizeToolInput(mcpAddInput, input))
    if (!parsed.success) throw new CoreError('invalid_request', 'MCP 创建参数无效')
    const args = parsed.data
    const name = normalizeMcpServerName(args.server_name)
    const owner = dataContext(identity.ownerId).ownerId
    if (digest([owner, name]) !== snapshot.targetsDigest) throw new CoreError('conflict', stale.message)
    const endpoint = agentEndpoint(args.endpoint, ports.validateEndpoint)
    return describeMcpAdd(name, endpoint, args.enabled ?? true, args.confirm_mode ?? 'confirm_all', Boolean(args.credential_slots?.length))
  }, async execute(input: AddInput, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
    const { identity, signal, roundId } = scope
    signal.throwIfAborted()
    if (scope.resolution) {
      const previous = await reconcile(input, identity, roundId, call)
      signal.throwIfAborted()
      if (previous.kind !== 'unknown') return previous
    }
    const key = operationKey(identity, roundId, call.id, 'add')
    const owner = key.context.ownerId
    const settings = ports.settings()
    let name: string, endpoint: string
    try { name = normalizeMcpServerName(input.server_name) }
    catch { return queryFailure('MCP 服务名称无效') }
    try { endpoint = agentEndpoint(input.endpoint, ports.validateEndpoint) }
    catch (error) { return queryFailure(error instanceof CoreError ? error.message : 'MCP 公网 HTTP 地址无效') }
    if (input.credential_slots?.length && !ports.stageCredential) return queryFailure('当前未开放 MCP 凭据填写')
    let credentialSlots
    try { credentialSlots = normalizeMcpSlots(input.credential_slots ?? []) }
    catch { return queryFailure('MCP Header 凭据槽位无效') }
    const configuration: McpServerCreateInput = {
      name, endpoint, transport: 'http', command: '', credential_slots: credentialSlots.map(slot => ({ ...slot })), credential_values: {},
      enabled: input.enabled ?? true, confirm_mode: input.confirm_mode ?? 'confirm_all',
      timeout_seconds: input.timeout_seconds ?? settings.default_timeout_seconds, tool_allowlist: input.tool_allowlist ?? [],
    }
    try { validateMcpCommon(configuration, settings.max_tools_per_server) }
    catch { return queryFailure('MCP 确认模式、超时或工具白名单无效') }

    try {
      if (!scope.resolution) await create.assertAvailable(owner, name)
      signal.throwIfAborted()
      const origin = new URL(endpoint).origin
      const snapshot = {
        targetRefs: { mcp_server_name: [digest(name)] }, targetsDigest: digest([owner, name]),
        versionsDigest: digest(configuration),
        displaySummary: describeMcpAdd(name, endpoint, configuration.enabled, configuration.confirm_mode, credentialSlots.length > 0),
      }
      const inputDigest = digest(configuration)
      if (!scope.resolution) {
        const prepared = await ports.confirmation.gate.prepare(call, scope, inputDigest, snapshot)
        return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : queryFailure(stale.message)
      }
      const verified = await ports.confirmation.gate.verify(call, scope, inputDigest, snapshot)
      if (!verified.ok) {
        const previous = await reconcile(input, identity, roundId, call)
        return previous.kind !== 'unknown' ? previous : queryFailure(stale.message)
      }
      const receipt = await runtime.operationWithTransaction<Receipt>(key.context, key.operationId, method, input, async tx => {
        if (!await ports.authorize(tx, identity, signal) || !await ports.confirmation.claim(tx, verified.value, signal)) throw stale
        signal.throwIfAborted()
        const createInTransaction = createMcpServerCreator<Database>(tx, creatorOptions, runtime.backend)
        const { id, scope: source, transport, credential_slots, credential_state, enabled, confirm_mode, timeout_seconds, tool_allowlist, created_at } =
          await createInTransaction(owner, configuration)
        let credentialRequestId: string | undefined
        if (credentialSlots.length && ports.stageCredential) {
          credentialRequestId = ports.id()
          await ports.stageCredential(tx, identity, { id: credentialRequestId, kind: 'credential', toolCall: call }, id)
        }
        return { success: true, server: { id, name, scope: source, transport, endpoint: origin,
          credential_slots: slotDefinitions(credential_slots), credential_state, enabled, confirm_mode, timeout_seconds, tool_allowlist, created_at },
          ...(credentialRequestId ? { credentialRequestId } : {}) }
      }, { signal })
      return configurationResult(receipt.result, call, !receipt.replayed)
    } catch (error) {
      if (error === stale) return queryFailure(stale.message)
      if (error instanceof CoreError && ['invalid_request', 'conflict'].includes(error.code)) return queryFailure(error.message)
      return reconcile(input, identity, roundId, call)
    }
  } }
}

function editParams(input: EditInput) {
  const selector = normalizedSelector(input)
  if (input.action !== 'update') return { ...selector, enabled: input.action === 'enable' }
  const { server_id: _id, server_name: _name, action: _action, ...fields } = input
  return { ...selector, ...fields }
}

function endpointChangeAllowed(row: McpStoredServer) {
  return row.transport === 'http' && !row.encrypted_credentials && !row.encrypted_headers && !row.encrypted_query_params
    && (!Array.isArray(row.credential_slots) || row.credential_slots.length === 0)
}

function describeMcpUpdate(row: McpStoredServer, patch?: McpServerPatch) {
  const changes = [
    ...(patch?.endpoint ? [`连接地址（${new URL(patch.endpoint).origin}）`] : []),
    ...(patch?.confirm_mode === 'auto' ? ['允许自动确认'] : []),
    ...(patch?.tool_allowlist ? ['调整工具白名单'] : []),
    ...(patch?.credential_slots ? [patch.credential_slots.length
      ? '更换 Header 凭据槽位并清除旧凭据，确认后请通过私密表单填写新凭据'
      : '移除全部凭据槽位并清除旧凭据'] : []),
  ].join('、')
  const name = row.name.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  return `将更新 MCP 服务「${name}」的${changes}`
}

export async function describeMcpManagementUpdate(tx: Transaction<Database>, identity: RunIdentity, input: unknown,
  snapshot: { targetsDigest: string; versionsDigest: string }, backend: SqlDataRuntime['backend'], validateEndpoint: (endpoint: string) => string) {
  const parsed = updateSchema.safeParse(normalizeToolInput(mcpUpdateInput, input))
  if (!parsed.success) throw new CoreError('invalid_request', 'MCP 更新参数无效')
  const params = normalizedSelector(parsed.data)
  const row = (await createMcpServerConfigLister<Database>(tx, backend)(identity.ownerId, tx)).find(item =>
    params.server_id ? item.id === params.server_id : item.name === params.server_name)
  if (!row || digest([row.id]) !== snapshot.targetsDigest || versionOf(row) !== snapshot.versionsDigest)
    throw new CoreError('conflict', 'MCP 更新目标已变化')
  return describeMcpUpdate(row, {
    endpoint: parsed.data.endpoint === undefined ? undefined : agentEndpoint(parsed.data.endpoint, validateEndpoint),
    confirm_mode: parsed.data.confirm_mode,
    tool_allowlist: parsed.data.tool_allowlist,
    credential_slots: parsed.data.credential_slots?.map(slot => ({ ...slot })),
  })
}

/** 配置、持久目录失效和收据原子提交，连接刷新在提交后执行。 */
export function createMcpManagementEditOperations(runtime: SqlDataRuntime, ports: {
  decrypt: McpEnvelopeCrypto['decrypt']
  authorize(tx: Transaction<Database>, identity: RunIdentity, signal: AbortSignal): Promise<boolean>
  afterCommit(ownerId: string, serverId: string, reload: boolean, signal: AbortSignal): Promise<{ ok: boolean; state: string; error: string | null } | void>
  update?: {
    crypto: McpEnvelopeCrypto
    maxTools: number | (() => number)
    validateEndpoint(endpoint: string): string
    confirmation: ClientDeleteConfirmationPort
    credential?: { id(): string; stage: StageMcpCredential }
  }
}) {
  if (!runtime.receipts) throw new Error('MCP 配置写入需要持久操作收据')
  const noReceipt = new Error('MCP 配置收据不存在')
  const unauthorized = new Error('当前运行已失去 MCP 配置权限')
  const stale = new Error('MCP 更新确认已使用或目标已变化')
  const missing = 'MCP server 不存在或不属于当前账号'
  type Receipt = { success: true; server: Awaited<ReturnType<typeof safeServerView>>; credentialRequestId?: string }
  const list = createMcpServerConfigLister(runtime.db, runtime.backend)
  const namespace = (input: EditInput) => input.action === 'update' ? 'update' as const : 'toggle' as const
  function choose(rows: readonly McpStoredServer[], params: ReturnType<typeof normalizedSelector>) {
    return rows.find(row => params.server_id ? row.id === params.server_id : row.name === params.server_name)
  }
  async function reconcile(input: EditInput, identity: RunIdentity, roundId: string, call: ToolCall): Promise<ToolResult> {
    const kind = namespace(input)
    const key = operationKey(identity, roundId, call.id, kind)
    try {
      const { result } = await runtime.operationWithTransaction<Receipt>(key.context, key.operationId, `agent.mcp.${kind}`, editParams(input), async () => { throw noReceipt })
      return configurationResult(result, call, false)
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return queryFailure(error.message)
      return { kind: 'unknown' }
    }
  }
  return { updates: Boolean(ports.update), credentials: Boolean(ports.update?.credential), reconcile, async execute(input: EditInput, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
    scope.signal.throwIfAborted()
    const params = editParams(input)
    if (params.server_id && !mcpUuid.test(params.server_id)) return queryFailure('MCP server id 无效')
    if (!params.server_id && !params.server_name) return queryFailure('需要提供 server_id 或 server_name')
    const { identity, signal, roundId } = scope
    const kind = namespace(input)
    const key = operationKey(identity, roundId, call.id, kind)
    const owner = key.context.ownerId
    const update = input.action === 'update' ? ports.update : undefined
    const requiresConfirmation = input.action === 'update'
      && (input.endpoint !== undefined || input.confirm_mode === 'auto' || input.tool_allowlist !== undefined || input.credential_slots !== undefined)
    if (scope.resolution && !requiresConfirmation) return queryFailure('该操作不接受确认回执')
    if (input.action === 'update' && !update) return queryFailure('当前未开放 MCP 配置更新')

    let patch: McpServerPatch | undefined
    if (input.action === 'update' && update) {
      try {
        const name = input.new_server_name === undefined ? undefined : normalizeMcpServerName(input.new_server_name)
        const endpoint = input.endpoint === undefined ? undefined : agentEndpoint(input.endpoint, update.validateEndpoint)
        patch = { name, endpoint, enabled: input.enabled, confirm_mode: input.confirm_mode,
          timeout_seconds: input.timeout_seconds, tool_allowlist: input.tool_allowlist }
      } catch (error) {
        return queryFailure(error instanceof CoreError ? error.message : 'MCP 服务名称无效')
      }
      if (input.credential_slots !== undefined) {
        if (!update.credential) return queryFailure('当前未开放 MCP 凭据填写')
        try {
          patch.credential_slots = normalizeMcpSlots(input.credential_slots).map(slot => ({ ...slot }))
          patch.credential_values = {}
        } catch { return queryFailure('MCP Header 凭据槽位无效') }
      }
    }

    const confirmation = requiresConfirmation ? update?.confirmation : undefined
    let verified: Awaited<ReturnType<ClientDeleteConfirmationPort['gate']['verify']>> | undefined
    let snapshot: { targetRefs: { mcp_server: string[] }; targetsDigest: string; versionsDigest: string; displaySummary: string } | undefined
    if (confirmation) {
      if (scope.resolution) {
        const previous = await reconcile(input, identity, roundId, call)
        signal.throwIfAborted()
        if (previous.kind !== 'unknown') return previous
      }
      const target = choose(await list(owner), params)
      signal.throwIfAborted()
      if (!target) return queryFailure(missing)
      if (patch?.endpoint && !endpointChangeAllowed(target)) return queryFailure('含凭据或非 HTTP 服务的连接地址须在设置中更新')
      if (patch?.credential_slots && target.transport !== 'http') return queryFailure('仅 HTTP 服务支持 Header 凭据槽位')
      snapshot = { targetRefs: { mcp_server: [target.id] }, targetsDigest: digest([target.id]), versionsDigest: versionOf(target),
        displaySummary: describeMcpUpdate(target, patch) }
      const inputDigest = digest(params)
      if (!scope.resolution) {
        const prepared = await confirmation.gate.prepare(call, scope, inputDigest, snapshot)
        return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : queryFailure('MCP 更新确认无效或已过期')
      }
      verified = await confirmation.gate.verify(call, scope, inputDigest, snapshot)
      if (!verified.ok) {
        const previous = await reconcile(input, identity, roundId, call)
        return previous.kind !== 'unknown' ? previous : queryFailure('MCP 更新确认无效或已过期')
      }
    }

    try {
      const receipt = await runtime.operationWithTransaction<Receipt>(key.context, key.operationId, `agent.mcp.${kind}`, params, async tx => {
        const selected = choose(await list(owner, tx), params)
        const target = selected && (await list(owner, tx, selected.id))[0]
        if (!target || (!params.server_id && target.name !== params.server_name))
          throw new CoreError('not_found', missing)
        if (!await ports.authorize(tx, identity, signal)) throw unauthorized
        let changed: Omit<McpStoredServer, 'updated_at'>
        let credentialRequestId: string | undefined
        if (patch && update && input.action === 'update') {
          if (snapshot && (target.id !== snapshot.targetRefs.mcp_server[0] || versionOf(target) !== snapshot.versionsDigest)) throw stale
          if (patch.endpoint && !endpointChangeAllowed(target)) throw new CoreError('invalid_request', '含凭据或非 HTTP 服务的连接地址须在设置中更新')
          if (input.transport === 'http' && target.transport !== 'http') throw new CoreError('invalid_request', '当前工具不支持切换 MCP 传输方式')
          if (confirmation && (!verified?.ok || !await confirmation.claim(tx, verified.value, signal))) throw stale
          const mutations = createMcpServerMutations<Database>(runtime.db, update, runtime.backend)
          changed = await mutations.updateStored(tx, owner, target.id, patch)
          if (patch.credential_slots?.length && update.credential) {
            credentialRequestId = update.credential.id()
            await update.credential.stage(tx, identity, { id: credentialRequestId, kind: 'credential', toolCall: call }, target.id)
          }
        } else {
          const enabled = input.action === 'enable'
          await setMcpServerEnabled<Database>(tx, owner, target.id, enabled, runtime.backend)
          changed = { ...target, enabled }
        }
        return { success: true, server: await safeServerView(changed, ports.decrypt, signal),
          ...(credentialRequestId ? { credentialRequestId } : {}) }
      }, { signal })
      if (receipt.replayed) return configurationResult(receipt.result, call, false)
      const outcome = configurationResult(receipt.result, call, true)
      const reload = input.action === 'enable'
      try {
        const status = await cancellable(ports.afterCommit(owner, receipt.result.server.id, reload, signal), signal)
        if (reload && status && !status.ok) return { kind: 'completed', successful: true, mutated: true,
          value: { ...receipt.result, state: status.state, tool_count: 0, error: status.error ?? 'MCP 工具加载失败' } }
      } catch {
        if (reload && !signal.aborted) return { kind: 'completed', successful: true, mutated: true,
          value: { ...receipt.result, state: 'unloaded', tool_count: 0, error: 'MCP 工具加载失败' } }
      }
      return outcome
    } catch (error) {
      if (error === unauthorized || error === stale) return queryFailure((error as Error).message)
      if (error instanceof CoreError && ['invalid_request', 'not_found', 'conflict'].includes(error.code)) return queryFailure(error.message)
      return reconcile(input, identity, roundId, call)
    }
  } }
}

/** 复用设置页删除事务。可信确认、删行、持久 schema 失效及操作收据一次提交。 */
export function createMcpManagementRemoveOperations(runtime: SqlDataRuntime, settings: {
  crypto: McpEnvelopeCrypto
  maxTools: number | (() => number)
}, options: McpManagementRemoveOptions) {
  if (!runtime.receipts) throw new Error('MCP 删除需要持久操作收据')
  const list = createMcpServerConfigLister<Database>(runtime.db, runtime.backend)
  const nothing = new Error('MCP 删除收据不存在')
  const stale = new Error('MCP 删除确认已使用或目标已变化')
  const rejected = (error: string): ToolResult => ({ kind: 'completed', successful: false, mutated: false, value: { error } })
  async function reconcile(input: RemovalInput, identity: RunIdentity, roundId: string, toolCallId: string): Promise<ToolResult> {
    const key = operationKey(identity, roundId, toolCallId, 'remove')
    try {
      const receipt = await runtime.operationWithTransaction(key.context, key.operationId, 'agent.mcp.remove', normalizedSelector(input), async () => { throw nothing })
      return { kind: 'completed', successful: true, mutated: false, value: receipt.result }
    } catch (error) {
      if (error instanceof CoreError && error.code === 'conflict') return rejected('操作标识已用于不同内容')
      return { kind: 'unknown' }
    }
  }
  return { reconcile, async describe(tx: Transaction<Database>, identity: RunIdentity, input: unknown,
    snapshot: { targetsDigest: string; versionsDigest: string }) {
    const parsed = removalSchema.safeParse(input)
    if (!parsed.success) throw new CoreError('invalid_request', 'MCP 删除参数无效')
    const params = normalizedSelector(parsed.data)
    const row = (await list(identity.ownerId, tx)).find(item =>
      params.server_id ? item.id === params.server_id : item.name === params.server_name)
    if (!row || digest([row.id]) !== snapshot.targetsDigest || versionOf(row) !== snapshot.versionsDigest)
      throw new CoreError('conflict', stale.message)
    return `删除 MCP server [${row.name}]`
  }, async execute(input: RemovalInput, scope: ToolScope, call: ToolCall): Promise<ToolResult> {
    scope.signal.throwIfAborted()
    const params = normalizedSelector(input)
    if (params.server_id && !mcpUuid.test(params.server_id)) return rejected('server_id 无效')
    if (!params.server_id && !params.server_name) return rejected('需要提供 server_id 或 server_name')
    if (scope.resolution) {
      const previous = await reconcile(input, scope.identity, scope.roundId, call.id)
      scope.signal.throwIfAborted()
      if (previous.kind === 'completed') return previous
    }
    const key = operationKey(scope.identity, scope.roundId, call.id, 'remove')
    const choose = (rows: readonly McpStoredServer[]) =>
      rows.find(row => params.server_id ? row.id === params.server_id : row.name === params.server_name)
    const target = choose(await list(key.context.ownerId))
    scope.signal.throwIfAborted()
    if (!target) return rejected('MCP server 不存在或不属于当前账号')
    const snapshot = { targetRefs: { mcp_server: [target.id] }, targetsDigest: digest([target.id]), versionsDigest: versionOf(target) }
    const inputDigest = digest(params)
    const confirmation = options.confirmation
    if (!scope.resolution) {
      const prepared = await confirmation.gate.prepare(call, scope, inputDigest, snapshot)
      return prepared.ok ? { kind: 'waiting', interaction: prepared.value } : rejected('MCP 删除确认无效或已过期')
    }
    const verified = await confirmation.gate.verify(call, scope, inputDigest, snapshot)
    if (!verified.ok) return rejected('MCP 删除确认无效或已过期')

    try {
      const receipt = await runtime.operationWithTransaction(key.context, key.operationId, 'agent.mcp.remove', params, async tx => {
        scope.signal.throwIfAborted()
        if (!await confirmation.claim(tx, verified.value, scope.signal)) throw stale
        const row = (await list(key.context.ownerId, tx, target.id))[0]
        scope.signal.throwIfAborted()
        if (!row || versionOf(row) !== snapshot.versionsDigest) throw stale
        const mutations = createMcpServerMutations<Database>(tx, settings, runtime.backend)
        await mutations.remove(key.context.ownerId, row.id)
        scope.signal.throwIfAborted()
        return { success: true, server_id: row.id, message: 'MCP server 已删除。' }
      }, { signal: scope.signal })
      if (!receipt.replayed) {
        try { await options.invalidate(key.context.ownerId, target.id) } catch { /* 正式目录读取数据库，缓存失败不撤回已提交删除。 */ }
      }
      return { kind: 'completed', successful: true, mutated: !receipt.replayed, value: receipt.result }
    } catch (error) {
      if (error === stale) return rejected(stale.message)
      return reconcile(input, scope.identity, scope.roundId, call.id)
    }
  } }
}
