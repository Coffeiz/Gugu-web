import { sql, type Kysely } from 'kysely'
import { CoreError, dataContext } from '../contracts/index.js'
import { normalizeMcpServerName, normalizeMcpSlots, validateMcpCredentialValues, type McpCredentialSlot } from './server-config.js'
import type { McpEnvelope } from './server-create.js'
import { isMcpUniqueViolation, mcpJsonArray, mcpOwnerKey, type McpDatabaseBackend } from './storage.js'

export interface McpServerPatch {
  name?: string | null
  transport?: 'http' | 'stdio' | null
  endpoint?: string | null
  command?: string | null
  credential_slots?: readonly Record<string, unknown>[] | null
  credential_values?: Record<string, string> | null
  enabled?: boolean | null
  confirm_mode?: string | null
  timeout_seconds?: number | null
  tool_allowlist?: readonly string[] | null
}

interface Stored {
  id: string; name: string; transport: 'http' | 'stdio'; endpoint: string
  encrypted_endpoint: string; endpoint_nonce: string; encrypted_endpoint_key: string; endpoint_key_version: number
  command: string; credential_slots: unknown; encrypted_credentials: string; credentials_nonce: string
  encrypted_credentials_key: string; credentials_key_version: number; enabled: boolean; confirm_mode: string
  encrypted_headers: string; headers_nonce: string; encrypted_headers_key: string; headers_key_version: number
  encrypted_query_params: string; query_params_nonce: string; encrypted_query_params_key: string; query_params_key_version: number
  timeout_seconds: number; tool_allowlist: unknown; created_at: Date | string | null
}

export interface McpEnvelopeCrypto {
  encrypt(plaintext: string): Promise<McpEnvelope>
  decrypt(input: { ciphertext: string; nonce: string; encryptedDataKey: string; keyVersion: number }): Promise<string>
}

/** 启停仅改状态和更新时间，保留已有端点、凭据密文与其他字段。 */
export async function setMcpServerEnabled<DB>(db: Kysely<DB>, ownerId: string, id: string, enabled: boolean, backend: McpDatabaseBackend) {
  const owner = mcpOwnerKey(dataContext(ownerId).ownerId, backend)
  const work = async (tx: Kysely<DB>) => {
    const result = await sql`UPDATE user_mcp_servers SET enabled=${backend === 'sqlite' ? Number(enabled) : enabled}, updated_at=CURRENT_TIMESTAMP
      WHERE id=${id} AND user_id=${owner} AND scope='user' RETURNING id`.execute(tx)
    if (!result.rows.length) throw new CoreError('not_found', 'MCP server 不存在')
    await sql`DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=${owner}`.execute(tx)
  }
  if (db.isTransaction) return work(db)
  return db.transaction().execute(work)
}

async function readCredentials(row: Stored, crypto: McpEnvelopeCrypto) {
  if (!row.encrypted_credentials) return {} as Record<string, string>
  try {
    const raw = await crypto.decrypt({ ciphertext: row.encrypted_credentials, nonce: row.credentials_nonce,
      encryptedDataKey: row.encrypted_credentials_key, keyVersion: row.credentials_key_version })
    const value: unknown = JSON.parse(raw)
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
  } catch { /* 兼容旧版损坏密文：与 Python 编辑视图一致，不回显明文。 */ }
  return {} as Record<string, string>
}

async function readLegacyValues(row: Stored, crypto: McpEnvelopeCrypto, prefix: 'headers' | 'query_params') {
  const ciphertext = prefix === 'headers' ? row.encrypted_headers : row.encrypted_query_params
  if (!ciphertext) return {} as Record<string, string>
  try {
    const nonce = prefix === 'headers' ? row.headers_nonce : row.query_params_nonce
    const key = prefix === 'headers' ? row.encrypted_headers_key : row.encrypted_query_params_key
    const version = prefix === 'headers' ? row.headers_key_version : row.query_params_key_version
    const value: unknown = JSON.parse(await crypto.decrypt({ ciphertext, nonce, encryptedDataKey: key, keyVersion: version }))
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]))
  } catch { /* 历史密文损坏时与 Python 编辑视图一致，忽略该轨值。 */ }
  return {} as Record<string, string>
}

async function readEndpoint(row: Stored, crypto: McpEnvelopeCrypto) {
  if (!row.encrypted_endpoint) return row.endpoint
  try {
    return await crypto.decrypt({ ciphertext: row.encrypted_endpoint, nonce: row.endpoint_nonce,
      encryptedDataKey: row.encrypted_endpoint_key, keyVersion: row.endpoint_key_version })
  } catch { return '' }
}

/** MCP 配置变更与工具 schema 快照失效在同一事务内提交。 */
export function createMcpServerMutations<DB>(db: Kysely<DB>, options: {
  crypto: McpEnvelopeCrypto
  maxTools: number | (() => number)
}, backend: McpDatabaseBackend = 'postgres') {
  async function updateStored(tx: Kysely<DB>, rawOwner: string, rawId: string, patch: McpServerPatch) {
    const owner = mcpOwnerKey(dataContext(rawOwner).ownerId, backend)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId))
      throw new CoreError('not_found', 'MCP server 不存在')
    const selected = backend === 'postgres' ? await sql<Stored>`SELECT id::text AS id,name,transport,endpoint,encrypted_endpoint,endpoint_nonce,
      encrypted_endpoint_key,endpoint_key_version,command,credential_slots,encrypted_credentials,credentials_nonce,
      encrypted_credentials_key,credentials_key_version,encrypted_headers,headers_nonce,encrypted_headers_key,headers_key_version,
      encrypted_query_params,query_params_nonce,encrypted_query_params_key,query_params_key_version,
      enabled,confirm_mode,timeout_seconds,tool_allowlist,created_at
      FROM user_mcp_servers WHERE id=${rawId} AND user_id=${owner} AND scope='user' FOR UPDATE`.execute(tx) : await sql<Stored>`SELECT id,name,transport,endpoint,encrypted_endpoint,endpoint_nonce,
      encrypted_endpoint_key,endpoint_key_version,command,credential_slots,encrypted_credentials,credentials_nonce,
      encrypted_credentials_key,credentials_key_version,encrypted_headers,headers_nonce,encrypted_headers_key,headers_key_version,
      encrypted_query_params,query_params_nonce,encrypted_query_params_key,query_params_key_version,
      enabled,confirm_mode,timeout_seconds,tool_allowlist,created_at
      FROM user_mcp_servers WHERE id=${rawId} AND user_id=${owner} AND scope='user'`.execute(tx)
    const row = selected.rows[0]
    if (!row) throw new CoreError('not_found', 'MCP server 不存在')

    const name = patch.name == null ? row.name : normalizeMcpServerName(patch.name)
    const duplicate = await sql<{ id: string }>`SELECT id FROM user_mcp_servers
      WHERE user_id=${owner} AND scope='user' AND name=${name} AND id<>${rawId} LIMIT 1`.execute(tx)
    if (duplicate.rows.length) throw new CoreError('invalid_request', `名称 ${name} 已存在`)

    const transport = patch.transport ?? row.transport
    const endpoint = patch.endpoint ?? await readEndpoint(row, options.crypto)
    const command = patch.command ?? row.command
    let encryptedEndpoint = row.encrypted_endpoint, endpointNonce = row.endpoint_nonce
    let wrappedEndpointKey = row.encrypted_endpoint_key, endpointKeyVersion = row.endpoint_key_version
    if (patch.transport != null || patch.endpoint != null || (transport === 'http' && !row.encrypted_endpoint && Boolean(endpoint))) {
      if (transport === 'http') {
        if (!endpoint) throw new CoreError('invalid_request', 'endpoint 必须是包含主机名的 HTTP/HTTPS URL')
        const sealed = await options.crypto.encrypt(endpoint)
        encryptedEndpoint = sealed.ciphertext; endpointNonce = sealed.nonce
        wrappedEndpointKey = sealed.encryptedDataKey; endpointKeyVersion = sealed.keyVersion
      } else {
        encryptedEndpoint = ''; endpointNonce = ''; wrappedEndpointKey = ''; endpointKeyVersion = 1
      }
    }
    if (transport === 'stdio' && !command.trim()) throw new CoreError('invalid_request', 'stdio MCP server 必须填写启动命令')
    if (command.includes('\0')) throw new CoreError('invalid_request', 'stdio 启动命令无效')

    const slots: McpCredentialSlot[] = patch.credential_slots == null
      ? mcpJsonArray<McpCredentialSlot>(row.credential_slots)
      : normalizeMcpSlots(patch.credential_slots)
    let encryptedCredentials = row.encrypted_credentials, credentialsNonce = row.credentials_nonce
    let wrappedCredentialsKey = row.encrypted_credentials_key, credentialsKeyVersion = row.credentials_key_version
    let encryptedHeaders = row.encrypted_headers, headersNonce = row.headers_nonce
    let wrappedHeadersKey = row.encrypted_headers_key, headersKeyVersion = row.headers_key_version
    let encryptedQuery = row.encrypted_query_params, queryNonce = row.query_params_nonce
    let wrappedQueryKey = row.encrypted_query_params_key, queryKeyVersion = row.query_params_key_version
    if (patch.credential_values != null) {
      const values = validateMcpCredentialValues(slots, patch.credential_values)
      if (Object.keys(values).length) {
        const sealed = await options.crypto.encrypt(JSON.stringify(values))
        encryptedCredentials = sealed.ciphertext; credentialsNonce = sealed.nonce
        wrappedCredentialsKey = sealed.encryptedDataKey; credentialsKeyVersion = sealed.keyVersion
      } else {
        encryptedCredentials = ''; credentialsNonce = ''; wrappedCredentialsKey = ''; credentialsKeyVersion = 1
      }
      encryptedHeaders = ''; headersNonce = ''; wrappedHeadersKey = ''; headersKeyVersion = 1
      encryptedQuery = ''; queryNonce = ''; wrappedQueryKey = ''; queryKeyVersion = 1
    }
    const confirmMode = patch.confirm_mode ?? row.confirm_mode
    const timeout = patch.timeout_seconds ?? row.timeout_seconds
    const enabled = patch.enabled ?? Boolean(row.enabled)
    const enabledValue = backend === 'sqlite' ? Number(enabled) : enabled
    const allowlist = patch.tool_allowlist ?? mcpJsonArray<string>(row.tool_allowlist)
    const maxTools = typeof options.maxTools === 'function' ? options.maxTools() : options.maxTools
    if (!['auto', 'confirm_all'].includes(confirmMode)) throw new CoreError('invalid_request', '确认模式只支持 auto / confirm_all')
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new CoreError('invalid_request', '超时秒数需在 1-300 之间')
    if (allowlist.length > maxTools) throw new CoreError('invalid_request', `工具白名单最多 ${maxTools} 个工具`)
    if (allowlist.some(tool => typeof tool !== 'string' || !tool.trim())) throw new CoreError('invalid_request', '白名单工具名不能为空')

    const slotsJson = JSON.stringify(slots), allowlistJson = JSON.stringify(allowlist)
    try {
      if (backend === 'postgres') await sql`UPDATE user_mcp_servers SET name=${name},transport=${transport},endpoint='',encrypted_endpoint=${encryptedEndpoint},
        endpoint_nonce=${endpointNonce},encrypted_endpoint_key=${wrappedEndpointKey},endpoint_key_version=${endpointKeyVersion},
        command=${command},credential_slots=${slotsJson}::jsonb,encrypted_credentials=${encryptedCredentials},
        credentials_nonce=${credentialsNonce},encrypted_credentials_key=${wrappedCredentialsKey},
        credentials_key_version=${credentialsKeyVersion},encrypted_headers=${encryptedHeaders},headers_nonce=${headersNonce},
        encrypted_headers_key=${wrappedHeadersKey},headers_key_version=${headersKeyVersion},
        encrypted_query_params=${encryptedQuery},query_params_nonce=${queryNonce},encrypted_query_params_key=${wrappedQueryKey},
        query_params_key_version=${queryKeyVersion},enabled=${enabledValue},confirm_mode=${confirmMode},
        timeout_seconds=${timeout},tool_allowlist=${allowlistJson}::jsonb,updated_at=CURRENT_TIMESTAMP
        WHERE id=${rawId} AND user_id=${owner} AND scope='user'`.execute(tx)
      else await sql`UPDATE user_mcp_servers SET name=${name},transport=${transport},endpoint='',encrypted_endpoint=${encryptedEndpoint},
        endpoint_nonce=${endpointNonce},encrypted_endpoint_key=${wrappedEndpointKey},endpoint_key_version=${endpointKeyVersion},
        command=${command},credential_slots=${slotsJson},encrypted_credentials=${encryptedCredentials},
        credentials_nonce=${credentialsNonce},encrypted_credentials_key=${wrappedCredentialsKey},
        credentials_key_version=${credentialsKeyVersion},encrypted_headers=${encryptedHeaders},headers_nonce=${headersNonce},
        encrypted_headers_key=${wrappedHeadersKey},headers_key_version=${headersKeyVersion},
        encrypted_query_params=${encryptedQuery},query_params_nonce=${queryNonce},encrypted_query_params_key=${wrappedQueryKey},
        query_params_key_version=${queryKeyVersion},enabled=${enabledValue},confirm_mode=${confirmMode},
        timeout_seconds=${timeout},tool_allowlist=${allowlistJson},updated_at=CURRENT_TIMESTAMP
        WHERE id=${rawId} AND user_id=${owner} AND scope='user'`.execute(tx)
    } catch (error) {
      if (isMcpUniqueViolation(error)) throw new CoreError('invalid_request', `名称 ${name} 已存在`)
      throw error
    }
    await sql`DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=${owner}`.execute(tx)
    return { ...row, scope: 'user' as const, name, transport, endpoint: '', encrypted_endpoint: encryptedEndpoint, endpoint_nonce: endpointNonce,
      encrypted_endpoint_key: wrappedEndpointKey, endpoint_key_version: endpointKeyVersion, command, credential_slots: slots,
      encrypted_credentials: encryptedCredentials, credentials_nonce: credentialsNonce,
      encrypted_credentials_key: wrappedCredentialsKey, credentials_key_version: credentialsKeyVersion,
      encrypted_headers: encryptedHeaders, headers_nonce: headersNonce, encrypted_headers_key: wrappedHeadersKey, headers_key_version: headersKeyVersion,
      encrypted_query_params: encryptedQuery, query_params_nonce: queryNonce,
      encrypted_query_params_key: wrappedQueryKey, query_params_key_version: queryKeyVersion,
      enabled, confirm_mode: confirmMode, timeout_seconds: timeout,
      tool_allowlist: allowlist }
  }

  async function update(rawOwner: string, rawId: string, patch: McpServerPatch) {
    return db.transaction().execute(async tx => {
      const updated = await updateStored(tx, rawOwner, rawId, patch)
      const { name, transport, command, created_at, confirm_mode, timeout_seconds, enabled, tool_allowlist } = updated
      const [plainEndpoint, decryptedValues] = await Promise.all([readEndpoint(updated, options.crypto), readCredentials(updated, options.crypto)])
      let responseSlots = updated.credential_slots
      let credentialValues = decryptedValues
      if (!responseSlots.length && !Object.keys(credentialValues).length) {
        const [headers, query] = await Promise.all([
          readLegacyValues(updated, options.crypto, 'headers'), readLegacyValues(updated, options.crypto, 'query_params'),
        ])
        const legacy = [...Object.entries(headers).map(([name, value]) => ({ target: 'header' as const, name, value })),
          ...Object.entries(query).map(([name, value]) => ({ target: 'query' as const, name, value }))]
        if (legacy.length) {
          responseSlots = legacy.map((item, index) => ({ id: `legacy_${item.target}_${index}`, label: item.name, target: item.target, name: item.name, prefix: '' }))
          credentialValues = Object.fromEntries(legacy.map((item, index) => [`legacy_${item.target}_${index}`, item.value]))
        }
      }
      const endpointHasQueryCredentials = (() => { try { return [...new URL(plainEndpoint).searchParams.values()].some(value => !/^\{\{secret:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\}\}$/.test(value)) } catch { return false } })()
      const configured = Boolean(updated.encrypted_credentials || updated.encrypted_headers || updated.encrypted_query_params || endpointHasQueryCredentials)
      return {
        id: updated.id, name, scope: 'user', transport, endpoint: transport === 'http' ? plainEndpoint : '', command,
        credential_slots: responseSlots, credential_values: credentialValues,
        credential_state: { configured, slot_ids: responseSlots.map(slot => slot.id) }, has_credentials: configured,
        enabled, confirm_mode, timeout_seconds,
        tool_allowlist: [...tool_allowlist], created_at: created_at instanceof Date ? created_at.toISOString() : created_at,
      }
    })
  }

  async function remove(rawOwner: string, rawId: string) {
    const owner = mcpOwnerKey(dataContext(rawOwner).ownerId, backend)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId))
      throw new CoreError('not_found', 'MCP server 不存在')
    const work = async (tx: Kysely<DB>) => {
      const deleted = backend === 'postgres' ? await sql<{ id: string }>`DELETE FROM user_mcp_servers
        WHERE id=${rawId} AND user_id=${owner} AND scope='user' RETURNING id::text AS id`.execute(tx) : await sql<{ id: string }>`DELETE FROM user_mcp_servers
        WHERE id=${rawId} AND user_id=${owner} AND scope='user' RETURNING id`.execute(tx)
      if (!deleted.rows[0]) throw new CoreError('not_found', 'MCP server 不存在')
      await sql`DELETE FROM user_mcp_tool_schema_snapshots WHERE user_id=${owner}`.execute(tx)
      return { deleted: true, id: deleted.rows[0].id }
    }
    return db.isTransaction ? work(db) : db.transaction().execute(work)
  }

  return { update, updateStored, remove }
}
