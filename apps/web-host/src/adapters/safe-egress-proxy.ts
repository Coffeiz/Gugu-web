import { request as httpRequest } from 'node:http'
import { request as httpsRequest, Agent } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Socket } from 'node:net'
import { SafeEgressProbeError } from '@gugu/core/preferences/safe-egress-probe'

export interface SafeEgressProxy { url: string; authorization?: string; ca?: string }
/** DoH 使用固定可信域名作为 CONNECT 目标；业务目标使用已验证 IP。 */
export async function safeEgressRequest(proxy: SafeEgressProxy, origin: URL, connectHost: string, timeoutMs: number): Promise<{status:number; body:string}> {
  const endpoint = new URL(proxy.url), started = Date.now()
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started))
  let tunnel: Socket | undefined, secure: TLSSocket | undefined, agent: Agent | undefined
  try {
    tunnel = await new Promise<Socket>((resolve, reject) => {
      const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80')
      const request = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)({
        hostname: endpoint.hostname.replace(/^\[|\]$/g, ''), port, method: 'CONNECT', path: `${connectHost}:443`, agent: false,
        headers: { Host: `${connectHost}:443`, ...(proxy.authorization ? { 'Proxy-Authorization': proxy.authorization } : {}) },
        ...(proxy.ca ? { ca: proxy.ca } : {}),
      })
      const timer = setTimeout(() => request.destroy(new Error('超时')), remaining())
      request.once('error', () => { clearTimeout(timer); reject(new SafeEgressProbeError('proxy_unavailable', '代理连接失败或代理拒绝建立隧道')) })
      request.once('connect', (response, socket, head) => {
        clearTimeout(timer)
        if (response.statusCode !== 200) { socket.destroy(); reject(new SafeEgressProbeError('proxy_unavailable', response.statusCode === 407 ? '代理认证失败（HTTP 407）' : '代理连接失败或代理拒绝建立隧道')); return }
        if (head.length) socket.unshift(head)
        resolve(socket)
      })
      request.end()
    })
    secure = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = tlsConnect({ socket: tunnel, servername: origin.hostname, ...(proxy.ca ? { ca: proxy.ca } : {}) })
      const timer = setTimeout(() => socket.destroy(new Error('超时')), remaining())
      socket.once('secureConnect', () => { clearTimeout(timer); resolve(socket) })
      socket.once('error', () => { clearTimeout(timer); reject(new SafeEgressProbeError('tls_verification_failed', '目标站点 TLS 握手或证书验证失败，已拒绝连接')) })
    })
    agent = new Agent({ keepAlive: false })
    agent.createConnection = () => secure!
    return await new Promise((resolve, reject) => {
      const request = httpsRequest(origin, { method:'GET', agent, headers: origin.hostname === 'cloudflare-dns.com' ? { accept:'application/dns-json' } : { 'User-Agent':'Gugu-web/1.0' } }, response => {
        const chunks: Buffer[] = []; let size = 0
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error('响应过大')); else chunks.push(chunk) })
        response.once('error', reject)
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      const timer = setTimeout(() => request.destroy(new Error('超时')), remaining())
      request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end()
    })
  } finally { agent?.destroy(); secure?.destroy(); tunnel?.destroy() }
}
