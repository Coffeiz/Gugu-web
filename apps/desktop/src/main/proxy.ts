import { DesktopError } from './core-host.js'
import type { ProxyEndpoint } from '@gugu/core/providers/node'

export async function resolveDesktopSystemProxy(
  origin: unknown,
  resolve: (url: string) => Promise<string>,
): Promise<ProxyEndpoint | undefined> {
  if (typeof origin !== 'string') throw new DesktopError('invalid_request', '代理目标无效')
  const target = new URL(origin)
  if (target.origin !== origin || !['http:', 'https:'].includes(target.protocol))
    throw new DesktopError('invalid_request', '代理目标无效')
  if (['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) return
  const [kind, address] = (await resolve(target.origin)).split(';')[0]!.trim().split(/\s+/)
  if (kind === 'DIRECT') return
  if (!address || !['PROXY', 'HTTP', 'HTTPS'].includes(kind ?? ''))
    throw new DesktopError('unsupported', '当前系统代理类型不受支持')
  const endpoint = new URL(`${kind === 'HTTPS' ? 'https' : 'http'}://${address}`)
  if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash)
    throw new DesktopError('invalid_request', '系统代理地址无效')
  return { url: endpoint.href }
}
