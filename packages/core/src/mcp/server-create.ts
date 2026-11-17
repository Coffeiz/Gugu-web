import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { normalizeMcpServerName, normalizeMcpSlots, validateMcpCredentialValues } from './server-config.js'
import { isMcpUniqueViolation, mcpOwnerKey, type McpDatabaseBackend } from './storage.js'

export interface McpEnvelope {
  ciphertext: string
  nonce: string
  encryptedDataKey: string
  keyVersion: number
}

export interface McpServerCreateInput {
  name: string
  transport: 'http' | 'stdio'
  endpoint: string
  command: string
  credential_slots: readonly Record<string, unknown>[]
  credential_values: Record<string, string>
  enabled: boolean
  confirm_mode: string
  timeout_seconds: number
  tool_allowlist: readonly string[]
}

interface StoredServer {
  id: string
  name: string
  transport: string
  created_at: Date | string
}

/** 写入配置并清除旧工具声明快照；旧 Python Manager 下次读取时会据此重新发现工具。 */
export function createMcpServerCreator<DB>(db: Kysely<DB>, options: {
  maxServersPerUser: number | (() => number)
  id(): string
  encrypt(plaintext: string): Promise<McpEnvelope>
}, backend: McpDatabaseBackend = 'postgres') {
  return async (rawOwner: string, input: McpServerCreateInput) => {
    const owner = mcpOwnerKey(dataContext(rawOwner).ownerId, backend)
    const maxServers = typeof options.maxServersPerUser === 'function' ? options.maxServersPerUser() : options.maxServersPerUser
    if (!Number.isSafeInteger(maxServers) || maxServers < 0) throw new TypeError('MCP server 数量上限无效')
    const name = normalizeMcpServerName(input.name)
    const slots = normalizeMcpSlots(input.credential_slots)
    const credentials = validateMcpCredentialValues(slots, input.credential_values)
    const encryptedEndpoint = input.transport === 'http'
      ? await options.encrypt(input.endpoint)
      : { ciphertext: '', nonce: '', encryptedDataKey: '', keyVersion: 1 }
    const encryptedCredentials = Object.keys(credentials).length
      ? await options.encrypt(JSON.stringify(credentials))
      : { ciphertext: '', nonce: '', encryptedDataKey: '', keyVersion: 1 }
    const id = options.id()
    const enabledValue = backend === 'sqlite' ? Number(input.enabled) : input.enabled

    let stored: StoredServer
    try {
      stored = await db.transaction().execute(async (tx) => {
        const existing = await sql<{ id: string }>`SELECT id FROM user_mcp_servers
          WHERE user_id=${owner} AND scope='user' AND name=${name} LIMIT 1`.execute(tx)
        if (existing.rows.length) throw new CoreError('invalid_request', `名称 ${name} 已存在`)

        const count = await sql<{ count: number | string }>`SELECT count(*) AS count FROM user_mcp_servers
          WHERE user_id=${owner} AND scope='user'`.execute(tx)
        if (Number(count.rows[0]?.count ?? 0) >= maxServers)
          throw new CoreError('invalid_request', `每个用户最多添加 ${maxServers} 个 MCP server`)

        const result = backend === 'postgres' ? await sql<StoredServer>`INSERT INTO user_mcp_servers (
          id,user_id,scope,name,transport,endpoint,encrypted_endpoint,endpoint_nonce,encrypted_endpoint_key,endpoint_key_version,
          command,auth_mode,encrypted_headers,headers_nonce,encrypted_headers_key,headers_key_version,
          encrypted_query_params,query_params_nonce,encrypted_query_params_key,query_params_key_version,
          credential_slots,encrypted_credentials,credentials_nonce,encrypted_credentials_key,credentials_key_version,
          enabled,confirm_mode,timeout_seconds,tool_allowlist,created_at,updated_at
        ) VALUES (
          ${id},${owner},'user',${name},${input.transport},'',${encryptedEndpoint.ciphertext},${encryptedEndpoint.nonce},
          ${encryptedEndpoint.encryptedDataKey},${encryptedEndpoint.keyVersion},${input.command},'headers','','','',1,'','','',1,
          ${JSON.stringify(slots)}::jsonb,${encryptedCredentials.ciphertext},${encryptedCredentials.nonce},
          ${encryptedCredentials.encryptedDataKey},${encryptedCredentials.keyVersion},${enabledValue},${input.confirm_mode},
          ${input.timeout_seconds},${JSON.stringify(input.tool_allowlist)}::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
        ) RETURNING id::text AS id,name,transport,created_at`.execute(tx) : await sql<StoredServer>`INSERT INTO user_mcp_servers (
          id,user_id,scope,name,transport,endpoint,encrypted_endpoint,endpoint_nonce,encrypted_endpoint_key,endpoint_key_version,
          command,auth_mode,encrypted_headers,headers_nonce,encrypted_headers_key,headers_key_version,
          encrypted_query_params,query_params_nonce,encrypted_query_params_key,query_params_key_version,
          credential_slots,encrypted_credentials,credentials_nonce,encrypted_credentials_key,credentials_key_version,
          enabled,confirm_mode,timeout_seconds,tool_allowlist,created_at,updated_at
        ) VALUES (
          ${id},${owner},'user',${name},${input.transport},'',${encryptedEndpoint.ciphertext},${encryptedEndpoint.nonce},
          ${encryptedEndpoint.encryptedDataKey},${encryptedEndpoint.keyVersion},${input.command},'headers','','','',1,'','','',1,
          ${JSON.stringify(slots)},${encryptedCredentials.ciphertext},${encryptedCredentials.nonce},
          ${encryptedCredentials.encryptedDataKey},${encryptedCredentials.keyVersion},${enabledValue},${input.confirm_mode},
          ${input.timeout_seconds},${JSON.stringify(input.tool_allowlist)},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
        ) RETURNING id,name,transport,created_at`.execute(tx)
        await sql`DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=${owner}`.execute(tx)
        return result.rows[0]!
      })
    } catch (error) {
      if (isMcpUniqueViolation(error))
        throw new CoreError('invalid_request', `名称 ${name} 已存在`)
      throw error
    }

    const endpointHasQueryCredentials = (() => {
      try { return [...new URL(input.endpoint).searchParams.values()].some(value => !/^\{\{secret:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\}\}$/.test(value)) }
      catch { return false }
    })()
    const configured = Object.keys(credentials).length > 0 || endpointHasQueryCredentials
    return {
      id: stored.id,
      name: stored.name,
      scope: 'user',
      transport: input.transport,
      endpoint: input.transport === 'http' ? input.endpoint : '',
      command: input.command,
      credential_slots: slots,
      credential_values: credentials,
      credential_state: { configured, slot_ids: slots.map(slot => slot.id) },
      has_credentials: configured,
      enabled: input.enabled,
      confirm_mode: input.confirm_mode,
      timeout_seconds: input.timeout_seconds,
      tool_allowlist: [...input.tool_allowlist],
      created_at: stored.created_at instanceof Date ? stored.created_at.toISOString() : stored.created_at,
    }
  }
}
