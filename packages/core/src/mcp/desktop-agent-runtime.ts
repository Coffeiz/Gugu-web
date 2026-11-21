import { createHash } from 'node:crypto'
import type { Kysely } from 'kysely'
import { pinyin } from 'pinyin-pro'
import type { Database } from '../data/schema.js'
import type { ProviderTransport } from '../agent/providers/contracts.js'
import { dataContext } from '../contracts/index.js'
import { createMcpHttpClient } from './sdk-client.js'
import { createMcpSafeFetch } from './safe-fetch.js'
import { createMcpServerConfigLister, type McpStoredServer } from './server-list.js'
import { createMcpToolDirectory, type McpDirectoryTool } from './tool-directory.js'
import { createMcpSnapshotStore } from './snapshot-store.js'
import { mcpConfigDigestPayload } from './config-digest.js'
import { descriptionForProvider, descriptionShortOf, prefixedToolName, sanitizeInputSchema, validateInputArguments, validateInputSchema } from './schema-adapter.js'
import { normalizeMcpSlots, validateMcpCredentialValues } from './server-config.js'
import type { McpEnvelopeCrypto } from './server-mutations.js'

function digest(rows: readonly McpStoredServer[]) {
  const stamp = (value: Date | string | null) => value === null ? '' : value instanceof Date
    ? value.toISOString() : value.replace(' ', 'T')
  return createHash('sha256').update(mcpConfigDigestPayload(rows.map(row => ({
    id: row.id, name: row.name, transport: row.transport, updated_at: stamp(row.updated_at),
    allowlist: Array.isArray(row.tool_allowlist) ? row.tool_allowlist.filter((item): item is string => typeof item === 'string') : [],
  })))).digest('hex')
}

async function decryptedJson(crypto: McpEnvelopeCrypto, row: McpStoredServer, kind: 'credentials' | 'headers') {
  const ciphertext = row[`encrypted_${kind}`]
  if (!ciphertext) return {} as Record<string, string>
  const value: unknown = JSON.parse(await crypto.decrypt({ ciphertext, nonce: row[`${kind}_nonce`],
    encryptedDataKey: row[`encrypted_${kind}_key`], keyVersion: row[`${kind}_key_version`] }))
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
}

async function headersFor(crypto: McpEnvelopeCrypto, row: McpStoredServer) {
  const slots = normalizeMcpSlots(Array.isArray(row.credential_slots)
    ? row.credential_slots.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [])
  const credentials = validateMcpCredentialValues(slots, await decryptedJson(crypto, row, 'credentials'))
  const headers: Record<string, string> = {}
  for (const slot of slots) {
    const value = credentials[slot.id]
    if (value === undefined || slot.target === 'query') throw new Error('MCP 凭据配置无效')
    headers[slot.name] = slot.prefix + value
  }
  Object.assign(headers, await decryptedJson(crypto, row, 'headers'))
  if (row.encrypted_query_params) throw new Error('MCP 凭据不得放入 URL')
  return headers
}

function resultText(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const content = (value as Record<string, unknown>).content
  if (!Array.isArray(content)) return ''
  return content.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const block = item as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    try { return [JSON.stringify(block)] } catch { return ['[无法读取的 MCP 内容]'] }
  }).join('\n').slice(0, 20_000)
}

/** Desktop 使用与 Web 相同的 owner 工具目录和 MCP schema 规则；密钥留在本地 Core。 */
export function createDesktopMcpAgentRuntime(db: Kysely<Database>, ownerId: string, crypto: McpEnvelopeCrypto,
  options: {
    transport(): ProviderTransport
    builtinNames(): Promise<ReadonlySet<string>>
    enabled?(): boolean
    client?(input: Parameters<typeof createMcpHttpClient>[0]): ReturnType<typeof createMcpHttpClient>
  }) {
  const list = createMcpServerConfigLister(db, 'sqlite')
  const configs = (owner: string, connection: Kysely<Database> = db) => list(owner, connection)
  const localOwner = dataContext(ownerId).ownerId
  const isLocalOwner = (owner: string) => dataContext(owner).ownerId === localOwner
  const snapshots = createMcpSnapshotStore(db, 'sqlite', async (owner, connection) =>
    digest((await configs(owner, connection)).filter(row => row.enabled)))
  const loadDirectory = createMcpToolDirectory({
    enabled: options.enabled ?? (() => true),
    configs: async owner => (await configs(owner)).filter(row => row.enabled), digest,
    read: snapshots.read, writeIfCurrent: snapshots.writeIfCurrent,
    async discover(_owner, rows) {
      const names = await options.builtinNames()
      const tools: McpDirectoryTool[] = []
      let complete = true
      for (const row of rows) {
        if (row.transport !== 'http') { complete = false; continue }
        let transport: ProviderTransport | undefined
        let client: ReturnType<typeof createMcpHttpClient> | undefined
        try {
          const endpoint = row.encrypted_endpoint
            ? await crypto.decrypt({ ciphertext: row.encrypted_endpoint, nonce: row.endpoint_nonce,
              encryptedDataKey: row.encrypted_endpoint_key, keyVersion: row.endpoint_key_version })
            : row.endpoint
          transport = options.transport()
          client = (options.client ?? createMcpHttpClient)({ endpoint, headers: await headersFor(crypto, row),
            fetch: createMcpSafeFetch(transport, { timeoutMs: Math.max(1000, Math.min(300_000, row.timeout_seconds * 1000)) }) })
          await client.connect()
          const allowlist = new Set(Array.isArray(row.tool_allowlist) ? row.tool_allowlist.filter((item): item is string => typeof item === 'string') : [])
          const serverTools = (await client.listTools()).tools
          const discovered: McpDirectoryTool[] = []
          for (const entry of serverTools) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
            const raw = entry as Record<string, unknown>
            const toolName = typeof raw.name === 'string' ? raw.name.trim() : ''
            if (!toolName || validateInputSchema(raw.inputSchema) !== null || (allowlist.size && !allowlist.has(toolName))) continue
            const name = prefixedToolName(row.name, toolName, text => pinyin(text, { toneType: 'none', type: 'array' }).join(''))
            if (!name || names.has(name) || tools.some(tool => tool.name === name) || discovered.some(tool => tool.name === name)) continue
            discovered.push({ name, description: descriptionForProvider(typeof raw.description === 'string' ? raw.description : null, `${row.name} MCP 工具：${toolName}`),
              description_short: descriptionShortOf(typeof raw.description === 'string' ? raw.description : null) || `${row.name} MCP 工具：${toolName}`,
              input_schema: sanitizeInputSchema(raw.inputSchema), server_id: row.id, server_name: row.name, tool_name: toolName })
          }
          if (discovered.length > 64) { complete = false; continue }
          tools.push(...discovered)
        } catch {
          complete = false
        } finally {
          await client?.close().catch(() => {})
          await transport?.close?.().catch(() => {})
        }
      }
      return { tools, complete }
    },
  })

  return {
    async state(owner: string, serverId: string) {
      const empty = { loaded_tool_count: 0, loaded_tool_names: [] as string[] }
      if (!isLocalOwner(owner)) return { state: 'unloaded', ...empty }
      const rows = await configs(owner)
      if (!rows.some(row => row.id === serverId && row.enabled)) return { state: 'disabled', ...empty }
      const snapshot = await snapshots.read(owner)
      if (snapshot?.digest !== digest(rows.filter(row => row.enabled))) return { state: 'unloaded', ...empty }
      const names = snapshot.tools.filter(tool => tool.server_id === serverId).map(tool => tool.name).sort()
      return { state: 'ok', loaded_tool_count: names.length, loaded_tool_names: names }
    },
    directory: async (owner: string) => isLocalOwner(owner) ? loadDirectory(owner) : [],
    async dispatchForAgent(owner: string, serverId: string, toolName: string, args: unknown, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (!isLocalOwner(owner)) return { error: 'MCP 工具不可用，请重新加载工具目录', executed: false as const }
      const row = (await configs(owner)).find(item => item.id === serverId)
      if (!row || !row.enabled || row.transport !== 'http' || !await (options.enabled?.() ?? true))
        return { error: 'MCP 工具不可用，请重新加载工具目录', executed: false as const }
      const tool = (await loadDirectory(owner)).find(item => item.server_id === serverId && item.name === toolName)
      if (!tool) return { error: 'MCP 工具不可用，请重新加载工具目录', executed: false as const }
      const validated = validateInputArguments(tool.name, tool.input_schema, args)
      if (!validated.success) return { result: JSON.stringify(validated.error), executed: false as const }
      signal?.throwIfAborted()
      let dispatched = false
      let transport: ProviderTransport | undefined
      let client: ReturnType<typeof createMcpHttpClient> | undefined
      try {
        const endpoint = row.encrypted_endpoint
          ? await crypto.decrypt({ ciphertext: row.encrypted_endpoint, nonce: row.endpoint_nonce,
            encryptedDataKey: row.encrypted_endpoint_key, keyVersion: row.endpoint_key_version }) : row.endpoint
        transport = options.transport()
        client = (options.client ?? createMcpHttpClient)({ endpoint, headers: await headersFor(crypto, row),
          fetch: createMcpSafeFetch(transport, { timeoutMs: Math.max(1000, Math.min(300_000, row.timeout_seconds * 1000)) }) })
        await client.connect()
        signal?.throwIfAborted()
        const current = (await configs(owner)).find(item => item.id === serverId)
        if (!current || !current.enabled || digest([current]) !== digest([row]))
          return { error: 'MCP 配置已变更，请重新加载工具目录', executed: false as const }
        signal?.throwIfAborted()
        dispatched = true
        const response = await client.callTool(tool.tool_name, validated.data, { signal, timeout: Math.max(1000, Math.min(300_000, row.timeout_seconds * 1000)) })
        signal?.throwIfAborted()
        if (response && typeof response === 'object' && !Array.isArray(response) && (response as Record<string, unknown>).isError === true)
          return { error: resultText(response).slice(0, 2000) || 'MCP 工具执行失败', executed: true as const }
        return { result: resultText(response), executed: true as const }
      } catch {
        signal?.throwIfAborted()
        return dispatched ? { uncertain: true as const }
          : { error: 'MCP 服务不可用，请检查连接配置', executed: false as const }
      } finally {
        await client?.close().catch(() => {})
        await transport?.close?.().catch(() => {})
      }
    },
  }
}
