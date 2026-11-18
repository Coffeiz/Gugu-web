import type { IncomingMessage, Server } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { authenticateUser } from '../../domains/auth/auth.js'
import type { UserAuthOptions } from '../../domains/auth/contracts.js'
import type { TerminalListItem } from '@gugu/core/terminals/list'

export type PtySession = { handle: { pid: number; sandboxId: string }; cols: number; rows: number; workspaceId: number | null }
type PtyQueue = { take(): Promise<Uint8Array | null> }
export type TerminalPtyManagerPort = {
  get(terminalId: string): unknown
  attach(terminalId: string): Promise<unknown>
  subscribe(terminalId: string): Promise<PtyQueue>
  unsubscribe(terminalId: string, queue: PtyQueue): Promise<void>
  detach(terminalId: string): Promise<void>
  write(terminalId: string, data: Uint8Array): Promise<void>
  resize(terminalId: string, cols: number, rows: number): Promise<void>
  signal(terminalId: string, name: 'SIGINT' | 'SIGTERM' | 'SIGTSTP'): Promise<void>
  terminate(terminalId: string): Promise<void>
  closeAll(): Promise<void>
}

export interface TerminalWebsocketOptions {
  auth: UserAuthOptions
  manager: TerminalPtyManagerPort
  runtime: {
    read(owner: string, terminal: string): Promise<TerminalListItem>
    startWithSubscription(owner: string, terminal: string): Promise<{ session: PtySession; queue: PtyQueue }>
  }
  state: {
    started(owner: string, terminal: string, session: PtySession): Promise<unknown>
    exited(owner: string, terminal: string): Promise<boolean>
  }
  accountCheckIntervalMs?: number
}

export type TerminalPtyStateOperations = TerminalWebsocketOptions['state']

function tokenFromRequest(request: IncomingMessage): { token: string; cookie: boolean } {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization))
    return { token: authorization.replace(/^Bearer\s+/i, ''), cookie: false }
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
  const protocol = protocols.find(value => value.startsWith('gugu-auth.'))
  if (protocol) return { token: protocol.slice('gugu-auth.'.length), cookie: false }
  const cookies = new Map(String(request.headers.cookie ?? '').split(';').map(value => {
    const index = value.indexOf('=')
    return index < 0 ? [value.trim(), ''] : [value.slice(0, index).trim(), value.slice(index + 1).trim()]
  }))
  return { token: cookies.get('gugu_user_access_token') ?? '', cookie: true }
}

function originAllowed(request: IncomingMessage): boolean {
  const value = request.headers.origin
  const host = request.headers.host
  if (typeof value !== 'string' || typeof host !== 'string') return false
  try {
    const origin = new URL(value)
    const forwarded = request.headers['x-forwarded-proto']
    const scheme = typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() : (request.socket as TLSSocket).encrypted ? 'https' : 'http'
    return origin.host.toLowerCase() === host.toLowerCase() && origin.protocol === `${scheme}:`
  } catch { return false }
}

function reject(socket: import('node:stream').Duplex, status: 401 | 403 | 404 | 503): void {
  const phrase = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : 'Service Unavailable'
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function clientMessage(data: RawData): unknown {
  const body = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
  if (body.byteLength > 64 * 1024) throw new Error('PTY input 超出单次大小限制')
  try { return JSON.parse(body.toString('utf8')) as unknown } catch { throw new Error('PTY 消息格式无效') }
}

function validateMessage(value: unknown):
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; signal: 'SIGINT' | 'SIGTERM' | 'SIGTSTP' }
  | { type: 'detach' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PTY 客户端消息必须是对象')
  const message = value as Record<string, unknown>
  if (message.type === 'input' && typeof message.data === 'string' && message.data.length > 0
    && Buffer.byteLength(message.data, 'utf8') <= 64 * 1024) return { type: 'input', data: message.data }
  if (message.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)
    && Number(message.cols) >= 20 && Number(message.cols) <= 500 && Number(message.rows) >= 5 && Number(message.rows) <= 200)
    return { type: 'resize', cols: Number(message.cols), rows: Number(message.rows) }
  if (message.type === 'signal' && ['SIGINT', 'SIGTERM', 'SIGTSTP'].includes(String(message.signal)))
    return { type: 'signal', signal: message.signal as 'SIGINT' | 'SIGTERM' | 'SIGTSTP' }
  if (message.type === 'detach') return { type: 'detach' }
  throw new Error('PTY 客户端消息无效')
}

/** Attach the Python-compatible WebSocket protocol to Fastify's actual HTTP server. */
export function registerTerminalWebsocket(server: Server, options: TerminalWebsocketOptions): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const pathPattern = /^\/api\/v1\/terminals\/([^/]+)\/ws\/?$/
  const upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    let pathname = ''
    try { pathname = new URL(request.url ?? '/', 'http://localhost').pathname } catch { /* 由 Fastify 的其他 upgrade handler 处理无效 URL。 */ }
    const match = pathPattern.exec(pathname)
    if (!match) return
    void (async () => {
      let terminalId: string
      try { terminalId = decodeURIComponent(match[1]!) } catch { reject(socket, 404); return }
      const credential = tokenFromRequest(request)
      if (!credential.token || (credential.cookie && !originAllowed(request))) { reject(socket, credential.token ? 403 : 401); return }
      let identity: { userId: string; securityVersion: number }
      try {
        const result = await authenticateUser({ method: 'GET', authorization: `Bearer ${credential.token}` }, options.auth.secret, options.auth.lookupUser)
        identity = result.identity
        await options.auth.markUserActive?.(identity.userId)
      } catch { reject(socket, 401); return }
      const owner = identity.userId
      try {
        const row = await options.runtime.read(owner, terminalId)
        if (row.mode !== 'interactive-pty') { reject(socket, 404); return }
      } catch (error) {
        const status = Number((error as { statusCode?: unknown })?.statusCode)
        reject(socket, status === 403 ? 403 : status === 503 ? 503 : 404)
        return
      }
      wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request)
        void runSession(ws, owner, identity.securityVersion, terminalId, options)
      })
    })().catch(() => { if (!socket.destroyed) reject(socket, 503) })
  }
  server.on('upgrade', upgrade)
  return async () => {
    server.off('upgrade', upgrade)
    for (const client of wss.clients) client.close(1001, 'Host 正在关闭')
    await options.manager.closeAll()
    await new Promise<void>(resolve => wss.close(() => resolve()))
  }
}

async function runSession(ws: WebSocket, owner: string, securityVersion: number, terminalId: string, options: TerminalWebsocketOptions): Promise<void> {
  let queue: PtyQueue | undefined
  let attached = false
  let session: PtySession | undefined
  let closed = false
  const clean = async () => {
    if (closed) return
    closed = true
    if (queue) await options.manager.unsubscribe(terminalId, queue).catch(() => undefined)
    if (attached) await options.manager.detach(terminalId).catch(() => undefined)
  }
  ws.once('close', () => { void clean() })
  try {
    const active = options.manager.get(terminalId)
    if (active) {
      await options.manager.attach(terminalId)
      attached = true
      queue = await options.manager.subscribe(terminalId)
      const row = await options.runtime.read(owner, terminalId)
      const current = active as { handle: PtySession['handle']; cols: number; rows: number }
      session = { handle: current.handle, cols: current.cols, rows: current.rows, workspaceId: row.workspaceId }
    } else {
      const started = await options.runtime.startWithSubscription(owner, terminalId)
      session = started.session
      queue = started.queue
      await options.manager.attach(terminalId)
      attached = true
    }
    await options.state.started(owner, terminalId, session)
    if (ws.readyState !== WebSocket.OPEN) { await clean(); return }
    ws.send(JSON.stringify({ type: 'ready', terminalId, mode: 'interactive-pty', cols: session.cols, rows: session.rows }))
    const accountCheck = setInterval(() => {
      void options.auth.lookupUser(owner).then(user => {
        if (!user || !user.isActive || (user.accountStatus ?? 'active') !== 'active'
          || (user.securityVersion || 1) !== securityVersion) {
          ws.close(4403, '登录已失效')
        }
      }).catch(() => { /* 一次数据库抖动不打断现存连接，下一轮继续复核。 */ })
    }, options.accountCheckIntervalMs ?? 1000)
    let messageTail = Promise.resolve()
    ws.on('message', data => {
      messageTail = messageTail.then(async () => {
        if (ws.readyState !== WebSocket.OPEN) return
        const message = validateMessage(clientMessage(data))
        if (message.type === 'input') await options.manager.write(terminalId, Buffer.from(message.data, 'utf8'))
        else if (message.type === 'resize') {
          await options.manager.resize(terminalId, message.cols, message.rows)
          ws.send(JSON.stringify({ type: 'status', cols: message.cols, rows: message.rows }))
        } else if (message.type === 'signal') await options.manager.signal(terminalId, message.signal)
        else ws.close(1000, 'detach')
      }).catch(error => {
        if (ws.readyState === WebSocket.OPEN) {
          const message = error instanceof Error ? error.message.slice(0, 120) : 'PTY 请求被拒绝'
          ws.send(JSON.stringify({ type: 'error', errorCode: 'pty_request_rejected', message }))
          ws.close(4400, '消息无效')
        }
      })
    })
    try {
      while (ws.readyState === WebSocket.OPEN) {
        const chunk = await queue.take()
        if (chunk === null) {
          const stillRunning = Boolean(options.manager.get(terminalId))
          if (!stillRunning) {
            await options.state.exited(owner, terminalId)
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'exit' }))
              ws.close(1000, 'exit')
            }
          } else if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', errorCode: 'pty_output_closed', message: 'PTY 输出连接已关闭' }))
            ws.close(4409, 'PTY 输出连接已关闭')
          }
          break
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'output', data: Buffer.from(chunk).toString('base64') }))
      }
    } finally { clearInterval(accountCheck) }
  } catch (error) {
    if (session && options.manager.get(terminalId)) await options.manager.terminate(terminalId).catch(() => undefined)
    if (ws.readyState === WebSocket.OPEN) {
      const status = Number((error as { statusCode?: unknown })?.statusCode)
      const code = status === 403 ? 4403 : status === 404 ? 4404 : 4409
      ws.send(JSON.stringify({ type: 'error', errorCode: 'pty_setup_failed', message: 'PTY 启动失败，请检查 Shell 权限和隔离运行时' }))
      ws.close(code, 'PTY 启动失败')
    }
  } finally { await clean() }
}
