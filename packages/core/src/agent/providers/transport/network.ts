import { throwIfCancelled } from '../errors.js'
import { BlockList, isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { ProviderError } from '../errors.js'

const blocked = new BlockList()
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const)
  blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const)
  blocked.addSubnet(network, prefix, 'ipv6')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return ['192.0.0.9', '192.0.0.10'].includes(address) || !blocked.check(address, 'ipv4')
  if (family !== 6 || address.includes('%')) return false
  // mapped IPv4 先还原再校验，不能把私有v4隐藏进v6。
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  if (normalized.startsWith('::ffff:')) {
    const parts = normalized.slice(7).split(':')
    if (parts.length !== 2) return false
    const bits = parts.map(value => Number.parseInt(value, 16))
    return isPublicAddress(`${bits[0]! >> 8}.${bits[0]! & 255}.${bits[1]! >> 8}.${bits[1]! & 255}`)
  }
  return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export interface ResolvedAddress { readonly address: string; readonly family: 4 | 6 }
export type AddressResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>
export const resolveAddresses: AddressResolver = async hostname => (await lookup(hostname, { all: true, verbatim: true }))
  .filter((item): item is ResolvedAddress => item.family === 4 || item.family === 6)

/** 校验与真实连接共用同一次DNS结果；混合公私地址整体拒绝。 */
export async function resolvePinnedTarget(raw: string, options: { allowLocal?: boolean; resolve?: AddressResolver; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ url: URL; target: ResolvedAddress }> {
  let url: URL
  try { url = new URL(raw) } catch { throw new ProviderError('input_rejected') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !url.hostname)
    throw new ProviderError('input_rejected')
  if ([...url.searchParams.keys()].some(name => /^(api[_-]?key|token|access_token|secret|authorization)$/i.test(name)))
    throw new ProviderError('input_rejected')
  throwIfCancelled(options.signal)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  let targets: readonly ResolvedAddress[]
  try {
    targets = family ? [{ address: hostname, family: family as 4 | 6 }] : await new Promise<readonly ResolvedAddress[]>((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new ProviderError('cancelled')) }
      const timer = setTimeout(() => { cleanup(); reject(new ProviderError('timeout', { retryable: true, requestStarted: false, timeoutPhase: 'connect' })) }, options.timeoutMs ?? 10_000)
      timer.unref()
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel) }
      options.signal?.addEventListener('abort', cancel, { once: true })
      void Promise.resolve().then(() => (options.resolve ?? resolveAddresses)(hostname)).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
  } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('network', { retryable: true, requestStarted: false }) }
  throwIfCancelled(options.signal)
  if (!targets.length || targets.some(item => !isIP(item.address) || (!options.allowLocal && !isPublicAddress(item.address))))
    throw new ProviderError('input_rejected')
  return { url, target: targets[0]! }
}
