import { classifyProviderError } from '../agent/providers/errors.js'
import { createNodeProviderTransport, desktopTransportOptions } from '../agent/providers/transport/node.js'
import { normalizeMcpSlots, validateMcpCredentialValues } from './server-config.js'
import { filterMcpConnectionTools } from './test-connection.js'
import { createMcpHttpClient } from './sdk-client.js'
import { createMcpSafeFetch } from './safe-fetch.js'

export type McpConfig = {
  endpoint: string; credential_slots: Record<string, unknown>[]; credential_values: Record<string, string>
  timeout_seconds: number; tool_allowlist: string[]
}

export async function testMcp(config: McpConfig, resolveProxy?: NonNullable<Parameters<typeof createNodeProviderTransport>[0]>['resolveProxy'],
  options: { allowLoopback?: boolean; signal?: AbortSignal } = {}): Promise<
    { ok: true; tool_count: number; tools: string[] }
    | { ok: false; errorKind: 'configuration' | 'auth' | 'timeout' | 'network' | 'protocol'; error: string; tool_count: number; tools: string[] }
  > {
  options.signal?.throwIfAborted()
  let connecting = false
  let rejectedCredentials = false
  let transport: ReturnType<typeof createNodeProviderTransport> | undefined
  let client: ReturnType<typeof createMcpHttpClient> | undefined
  try {
    const slots = normalizeMcpSlots(config.credential_slots)
    const values = validateMcpCredentialValues(slots, config.credential_values)
    const headers = new Headers()
    for (const slot of slots) {
      if (slot.target !== 'header' || values[slot.id] === undefined)
        return { ok: false, errorKind: 'configuration' as const, error: '请填写 MCP Header 凭据', tool_count: 0, tools: [] }
      headers.set(slot.name, slot.prefix + values[slot.id])
    }
    if (headers.has('host')) return { ok: false, errorKind: 'configuration' as const, error: 'MCP 凭据不能设置 Host 请求头', tool_count: 0, tools: [] }
    const endpoint = new URL(config.endpoint)
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      return { ok: false, errorKind: 'configuration' as const, error: 'MCP 地址不能包含凭据、查询参数或片段', tool_count: 0, tools: [] }
    // 只对用户显式填写的字面回环地址开放本地连接。其余目标沿用公网 DNS 防护。
    const allowLocal = options.allowLoopback !== false && (endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]')
    const pinned = createNodeProviderTransport({ ...desktopTransportOptions(allowLocal, resolveProxy), connectTimeoutMs: 5000, writeTimeoutMs: 10000 })
    transport = pinned
    const safeFetch = createMcpSafeFetch({
      request: (request, signal) => pinned.request({ ...request, allowLocal }, signal),
    }, { timeoutMs: config.timeout_seconds * 1000 })
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).origin !== endpoint.origin) throw new Error('MCP 请求不能跨来源')
      const response = await safeFetch(request, options.signal ? { signal: AbortSignal.any([request.signal, options.signal]) } : undefined)
      rejectedCredentials = response.status === 401 || response.status === 403
      return response
    }
    client = createMcpHttpClient({ endpoint: endpoint.toString(), fetch, headers: Object.fromEntries(headers) })
    connecting = true
    await client.connect()
    const tools = filterMcpConnectionTools((await client.listTools()).tools, { maxTools: 64, allowlist: config.tool_allowlist })
    return { ok: true, tool_count: tools.length, tools }
  } catch (error) {
    options.signal?.throwIfAborted()
    const { code } = classifyProviderError(error)
    const errorKind = !connecting || code === 'input_rejected' ? 'configuration'
      : rejectedCredentials || code === 'authentication' ? 'auth'
        : code === 'timeout' ? 'timeout' : code === 'network' ? 'network' : 'protocol'
    return { ok: false, errorKind, error: '无法连接 MCP 服务，请检查地址、凭据和网络', tool_count: 0, tools: [] }
  } finally {
    await client?.close().catch(() => {})
    await transport?.close?.().catch(() => {})
  }
}
