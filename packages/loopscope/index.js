export const defaultLoopScopeEndpoint = 'http://127.0.0.1:4320'
export { createLoopScopeTrace, loopScopeTraceEnabled } from './trace.js'

const readablePaths = new Set(['health', 'sessions', 'reflections', 'events'])

/** 只请求受信 Collector 的只读资源。由宿主注入校验目标且不跟随重定向的传输。 */
export function createLoopScopeClient({ endpoint = defaultLoopScopeEndpoint, transport }) {
  const base = endpoint.replace(/\/+$/, '')
  const parsed = new URL(base)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('LoopScope Collector 地址配置无效')
  }
  if (typeof transport?.request !== 'function') throw new TypeError('LoopScope 安全传输不可用')
  const api = base.endsWith('/api') ? base : `${base}/api`

  return {
    async read(path, query, signal) {
      const allowed = readablePaths.has(path)
        || /^sessions\/[A-Za-z0-9:_-]+\/runs$/.test(path)
        || /^runs\/[A-Za-z0-9_.:-]+(?:\/(?:spans|context|usage))?$/.test(path)
      if (!allowed) return null
      return transport.request({
        url: `${api}/${path}${query ? `?${query}` : ''}`,
        method: 'GET',
        allowLocal: true,
        headers: path === 'events' ? { Accept: 'text/event-stream' } : {},
      }, signal)
    },
  }
}
