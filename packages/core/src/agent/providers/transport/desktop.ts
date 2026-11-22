import { execFile } from 'node:child_process'
import { Resolver } from 'node:dns/promises'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import { rootCertificates } from 'node:tls'
import type { ProviderConfig } from '../contracts.js'
import { ProviderError } from '../errors.js'
import type { NodeProviderTransportOptions } from './node.js'
import { isSyntheticAddress, resolveAddresses, type AddressResolver, type ResolvedAddress } from './network.js'

// Electron 与独立 Node 使用自带根证书，避免开发终端的 NODE_OPTIONS 改变证书来源。
const bundledCa = rootCertificates.join('\n')

const run = promisify(execFile)

async function localDnsServers(): Promise<string[]> {
  if (process.platform !== 'darwin') return new Resolver().getServers()
  // macOS 的默认 DNS 可能已被 TUN 接管，读取活动网卡的 DHCP DNS。
  const interfaces = Object.entries(networkInterfaces())
    .filter(([name, addresses]) => /^en\d+$/.test(name) && addresses?.some(address => !address.internal && address.family === 'IPv4'))
  const leases = await Promise.all(interfaces.map(async ([name]) => {
    const result = await run('/usr/sbin/ipconfig', ['getoption', name, 'domain_name_server'], { timeout: 1000 }).catch(() => undefined)
    return result?.stdout.trim().split(/\s+/).filter(isIPv4) ?? []
  }))
  return leases.find(servers => servers.length > 0) ?? []
}

async function queryLocalDns(host: string): Promise<ResolvedAddress[]> {
  const servers = await localDnsServers()
  if (!servers.length) throw new ProviderError('network')
  const resolver = new Resolver({ timeout: 1500, tries: 1 })
  resolver.setServers(servers)
  return (await Promise.all(([4, 6] as const).map(async family => {
    try {
      const addresses = await (family === 4 ? resolver.resolve4(host) : resolver.resolve6(host))
      return addresses.map(address => ({ address, family }))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENODATA' || code === 'ENOTFOUND') return []
      throw error
    }
  }))).flat()
}

function isSynthetic({ address }: ResolvedAddress): boolean {
  return isSyntheticAddress(address)
}

// 仅重新解析全为 Fake IP 的结果。公网工具仍由传输层校验所有地址；走代理时由代理端解析目标域名。
export function createDesktopAddressResolver(system: AddressResolver, local: AddressResolver): AddressResolver {
  return async host => {
    const resolved = await system(host)
    if (!resolved.some(isSynthetic)) return resolved
    if (!resolved.every(isSynthetic)) throw new ProviderError('input_rejected')
    // 二次解析失败或仍返回合成地址时没有额外信息量：回落到系统结果，
    // 由上层按当前模式判断（代理模式交由代理解析，直连模式按非公网拒绝）。
    // 一次本地 DNS 抖动不应该把整条请求打掉。
    const localAddresses = await local(host).catch(() => [])
    if (!localAddresses.length || localAddresses.some(isSynthetic)) return resolved
    return localAddresses
  }
}

const resolveDesktopAddress = createDesktopAddressResolver(resolveAddresses, queryLocalDns)

export function desktopTransportOptions(allowLocal = false, resolveProxy?: NodeProviderTransportOptions['resolveProxy']): NodeProviderTransportOptions {
  return { allowLocal, trustEnvironment: false, resolve: resolveDesktopAddress, ...(allowLocal ? {} : { ca: bundledCa, resolveProxy }) }
}

export function desktopModelTransportOptions(config: ProviderConfig, resolveProxy?: NodeProviderTransportOptions['resolveProxy']): NodeProviderTransportOptions {
  const url = new URL(String(config.base_url))
  return desktopTransportOptions(['local', 'ollama'].includes(config.provider ?? '')
    && (url.hostname === '127.0.0.1' || url.hostname === '[::1]'), resolveProxy)
}
