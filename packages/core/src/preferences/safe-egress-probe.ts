export type SafeEgressStage = 'proxy_unavailable' | 'resolver_unavailable' | 'non_public_destination' | 'tls_verification_failed' | 'invalid_url'
export class SafeEgressProbeError extends Error {
  constructor(readonly stage: SafeEgressStage, message: string) { super(message) }
}
export interface SafeEgressProbePorts {
  queryDns(host: string, type: 'A' | 'AAAA'): Promise<unknown[]>
  isAddress(address: string): boolean
  isPublicAddress(address: string): boolean
  requestTarget(url: string, address: string): Promise<number>
  now(): number
}
const target = 'https://ja.wikipedia.org/wiki/Muque'
/** 对固定目标执行代理、DoH、公网地址与 TLS 连通性探测。 */
export function createSafeEgressProbe(ports: SafeEgressProbePorts) {
  return async () => {
    const started = ports.now()
    const elapsed = () => Math.round(ports.now() - started)
    try {
      const host = new URL(target).hostname
      const records = (await Promise.all([ports.queryDns(host, 'A'), ports.queryDns(host, 'AAAA')])).flat()
      const addresses: string[] = [], aliases = new Set<string>()
      for (const value of records) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const item = value as Record<string, unknown>
        if ((item.type === 1 || item.type === 28) && typeof item.data === 'string') {
          if (!ports.isAddress(item.data)) throw new SafeEgressProbeError('resolver_unavailable', '安全 DNS 返回了无效地址')
          if (!ports.isPublicAddress(item.data)) throw new SafeEgressProbeError('non_public_destination', '域名解析包含非公网地址，已拒绝请求')
          addresses.push(item.data)
        } else if (item.type === 5 && typeof item.data === 'string') aliases.add(item.data.replace(/\.$/, '').toLowerCase())
      }
      if (!addresses.length) throw new SafeEgressProbeError('resolver_unavailable', '安全 DNS 未返回公网地址')
      if (aliases.has(host)) throw new SafeEgressProbeError('resolver_unavailable', '安全 DNS 返回了循环别名')
      const status = await ports.requestTarget(target, addresses[0]!)
      return { ok: status >= 200 && status < 500, stage: status < 500 && status >= 200 ? 'connected' : 'upstream_http_error', message: status < 500 && status >= 200 ? '代理、DNS、IP 钉扎和 TLS 验证均已通过' : '已连通代理，但上游返回错误状态', status_code: status, elapsed_ms: elapsed() }
    } catch (error) {
      if (error instanceof SafeEgressProbeError) return { ok: false, stage: error.stage, message: error.message, elapsed_ms: elapsed() }
      return { ok: false, stage: 'proxy_unavailable', message: '代理连接或安全 TLS 握手失败', elapsed_ms: elapsed() }
    }
  }
}
