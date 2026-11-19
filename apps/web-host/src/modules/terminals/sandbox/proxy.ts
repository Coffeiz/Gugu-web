/** MXC Bubblewrap 代理专用模式只接受 Host 回环代理，不能直接使用远端 Docker 代理地址。 */
export function normalizeMxcEgressProxyUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('沙盒 egress 代理配置无效')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('沙盒 egress 代理地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('沙盒 egress 代理必须是无凭据的 HTTP/S 地址')
  if (!['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase()))
    throw new Error('MXC 代理必须是本机回环 HTTP/S 地址')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('沙盒 egress 代理端口无效')
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`
}
