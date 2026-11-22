import { throwIfCancelled } from '../errors.js'
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { ProviderError } from '../errors.js'

// Node BlockList 会把原生IPv4也匹配到IPv6 mapped子网，必须分开地址族。
const blockedV4 = new BlockList()
const blockedV6 = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const)
  blockedV4.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
  blockedV6.addSubnet(network, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

/**
 * 假 IP 段：本地 DNS 被 TUN 或代理接管后返回的合成地址（Clash/mihomo 默认 198.18.0.0/16）。
 * 这类地址不代表真实目标，既不能作为连接目标，也不能用来判断目标是否公网。
 */
const syntheticAddresses = new BlockList()
syntheticAddresses.addSubnet('198.18.0.0', 15, 'ipv4')
syntheticAddresses.addSubnet('2001:2::', 48, 'ipv6')

export function isSyntheticAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return syntheticAddresses.check(address, 'ipv4')
  if (family === 6) return syntheticAddresses.check(address, 'ipv6')
  return false
}

/**
 * 明确指向本机或内网的主机名：代理端解析时也不能靠这些名字触达本地服务。
 * 无点单标签主机名只可能由本机或局域网 DNS 解析；
 * 后缀只取真正指向内网的保留名（mDNS、云内网、家庭网段、localhost），
 * RFC 2606 的 .test/.example/.invalid 不在内——它们解析不到内网，拦它们没有防护价值。
 */
function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase()
  if (!name.includes('.')) return true
  return /(^|\.)(localhost|local|internal|home\.arpa)$/.test(name)
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return ['192.0.0.9', '192.0.0.10'].includes(address) || !blockedV4.check(address, 'ipv4')
  if (family !== 6 || address.includes('%')) return false
  // 保留mapped IPv6的拒绝边界；修复原生IPv4误拒不扩大IPv6可访问集合。
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  if (normalized.startsWith('::ffff:')) return false
  return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6')
}

/**
 * 明确的私网/回环/链路本地地址。
 * 代理模式用它判断「目标是否指向内网」：合成地址与特殊用途段（如 Teredo）
 * 不是私网，不能据此把真实公网域名判成非法目标。
 */
const privateV4 = new BlockList()
const privateV6 = new BlockList()
for (const [network, prefix] of [['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]] as const)
  privateV4.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
  privateV6.addSubnet(network, prefix, 'ipv6')

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return privateV4.check(address, 'ipv4')
  if (family !== 6) return false
  if (address.includes('%')) return true
  const normalized = address.toLowerCase()
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    return /^[0-9.]+$/.test(mapped) ? isPrivateAddress(mapped) : true
  }
  return normalized === '::' || privateV6.check(address, 'ipv6')
}

export interface ResolvedAddress { readonly address: string; readonly family: 4 | 6 }
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>
export const resolveAddresses: AddressResolver = async hostname => (await lookup(hostname, { all: true, verbatim: true }))
  .filter((item): item is ResolvedAddress => item.family === 4 || item.family === 6)

/** 校验与真实连接共用同一次DNS结果；混合公私地址整体拒绝。 */
export async function resolvePinnedTarget(raw: string, options: { allowLocal?: boolean; resolve?: AddressResolver; signal?: AbortSignal; timeoutMs?: number; proxyResolved?: boolean } = {}): Promise<{ url: URL; target: ResolvedAddress }> {
  let url: URL
  try { url = new URL(raw) } catch { throw new ProviderError('input_rejected') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname)
    throw new ProviderError('input_rejected')
  if ([...url.searchParams.keys()].some(name => /^(api[_-]?key|token|access_token|secret|authorization)$/i.test(name)))
    throw new ProviderError('input_rejected')
  throwIfCancelled(options.signal)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  if (family) {
    // 字面地址不经过域名解析：代理最终也要连它，必须先判定是否公网地址。
    if (!options.allowLocal && !isPublicAddress(hostname)) throw new ProviderError('input_rejected')
    return { url, target: { address: hostname, family: family as 4 | 6 } }
  }
  // 代理模式下代理端会重新解析域名，本地无法确认目标时只放行明显不指向本机的名字。
  if (options.proxyResolved && !options.allowLocal && isLocalHostname(hostname)) throw new ProviderError('input_rejected')
  let targets: readonly ResolvedAddress[]
  try {
    targets = await new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new ProviderError('cancelled')) }
      const timer = setTimeout(() => { cleanup(); reject(new ProviderError('timeout', { retryable: true, requestStarted: false, timeoutPhase: 'connect' })) }, options.timeoutMs ?? 10_000)
      timer.unref()
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
      options.signal?.addEventListener('abort', cancel, { once: true })
      void Promise.resolve().then(() => (options.resolve ?? resolveAddresses)(hostname)).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
  } catch (error) {
    // 解析失败保持 fail-closed：Web Host 侧以代理侧 DoH 作为唯一判定来源，
    // 这里放行会让那条唯一边界失效。桌面端在合成地址环境下解析本就成功。
    if (error instanceof ProviderError) throw new ProviderError(error.code, { ...error.options, transportHop: 'dns' })
    throw new ProviderError('network', { retryable: true, requestStarted: false, transportHop: 'dns' })
  }
  throwIfCancelled(options.signal)
  if (!targets.length || targets.some(item => !isIP(item.address))) throw new ProviderError('input_rejected')
  if (options.proxyResolved) {
    // 代理端才是权威解析方：本地结果可能是合成地址，也可能被污染成看起来像私网的地址，
    // 用「非公网」当拒绝依据会误杀真实公网域名；只在结果明确指向内网时拒绝。
    if (!options.allowLocal && targets.some(item => isPrivateAddress(item.address))) throw new ProviderError('input_rejected')
    return { url, target: { address: hostname, family: 4 } }
  }
  if (!options.allowLocal && targets.some(item => !isPublicAddress(item.address))) throw new ProviderError('input_rejected')
  return { url, target: targets[0]! }
}
