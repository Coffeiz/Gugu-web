import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import WebSocket from 'ws'
import { createApp } from '../../src/app.js'
import { createUserToken } from '../../src/modules/auth/auth.js'
import type { TerminalWebsocketOptions } from '../../src/modules/terminals/websocket.js'

const owner = '00000000-0000-4000-8000-000000000211'
const secret = 'synthetic-terminal-websocket-secret'

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`等待 WebSocket ${label} 超时`)), 1500) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
}

function queue() {
  const values: Array<Uint8Array | null> = []
  const readers: Array<(value: Uint8Array | null) => void> = []
  return {
    push(value: Uint8Array | null) { const reader = readers.shift(); if (reader) reader(value); else values.push(value) },
    take() { const value = values.shift(); return value !== undefined ? Promise.resolve(value) : new Promise<Uint8Array | null>(resolve => readers.push(resolve)) },
  }
}

function authOptions() {
  return {
    secret,
    async lookupUser(id: string) {
      return id === owner ? {
        id: owner, isActive: true, accountStatus: 'active', securityVersion: 1,
        username: 'synthetic', displayName: '合成用户', email: 'synthetic@example.invalid', avatarUrl: null,
        createdAt: null, timezone: 'UTC', emailSubscribed: false, imChannels: [],
      } : null
    },
  }
}

test('认证 WebSocket 建立真实 PTY 会话、转发输入控制和 Base64 输出，并复核账号状态', async () => {
  const output = queue()
  const calls: unknown[] = []
  const pty = { handle: { pid: 77, sandboxId: 'term-ws:77' }, cols: 120, rows: 32, workspaceId: 41 }
  let active: unknown
  const options: Omit<TerminalWebsocketOptions, 'auth'> = {
    manager: {
      get() { return active },
      async attach(id) { calls.push(['attach', id]) },
      async subscribe(id) { calls.push(['subscribe', id]); return output },
      async unsubscribe(id) { calls.push(['unsubscribe', id]); output.push(null) },
      async detach(id) { calls.push(['detach', id]) },
      async write(id, data) { calls.push(['write', id, Buffer.from(data).toString()]) },
      async resize(id, cols, rows) { calls.push(['resize', id, cols, rows]) },
      async signal(id, signal) { calls.push(['signal', id, signal]) },
      async terminate(id) { calls.push(['terminate', id]); active = undefined },
      async closeAll() { calls.push(['closeAll']) },
    },
    runtime: {
      async read() { return { id: 'term-ws', mode: 'interactive-pty', workspaceId: 41 } as never },
      async startWithSubscription() { active = { ...pty, handle: pty.handle }; return { session: pty, queue: output } },
    },
    state: {
      async started(id, terminal, session) { calls.push(['started', id, terminal, session.handle.sandboxId]) },
      async exited(id, terminal) { calls.push(['exited', id, terminal]); return true },
    },
    accountCheckIntervalMs: 25,
  }
  const app = createApp({
    appName: '测试应用', isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id: string) {
        return id === owner ? {
          id: owner, isActive: true, accountStatus: 'active', securityVersion: 1,
          username: 'synthetic', displayName: '合成用户', email: 'synthetic@example.invalid', avatarUrl: null,
          createdAt: null, timezone: 'UTC', emailSubscribed: false, imChannels: [],
        } : null
      },
    },
    terminalWebsocket: options,
  })
  let client: WebSocket | undefined
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const token = createUserToken(owner, 1, secret)
    client = new WebSocket(`${address.replace('http://', 'ws://')}/api/v1/terminals/term-ws/ws`, [`gugu-auth.${token}`])
    const readyPromise = within(once(client, 'message'), 'ready frame')
    const closed = once(client, 'close')
    await within(Promise.race([once(client, 'open'), once(client, 'error').then(([error]) => { throw error })]), 'open')
    const ready = JSON.parse(String((await readyPromise)[0]))
    assert.deepEqual(ready, { type: 'ready', terminalId: 'term-ws', mode: 'interactive-pty', cols: 120, rows: 32 })
    output.push(Buffer.from('prompt'))
    const frame = JSON.parse(String((await within(once(client, 'message'), 'output frame'))[0]))
    assert.deepEqual(frame, { type: 'output', data: Buffer.from('prompt').toString('base64') })
    client.send(JSON.stringify({ type: 'input', data: 'pwd\n' }))
    client.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }))
    client.send(JSON.stringify({ type: 'signal', signal: 'SIGINT' }))
    for (let attempt = 0; attempt < 30 && calls.filter(value => Array.isArray(value) && ['write', 'resize', 'signal'].includes(String(value[0]))).length < 3; attempt++)
      await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(calls.filter(value => Array.isArray(value) && ['write', 'resize', 'signal'].includes(String(value[0]))), [
      ['write', 'term-ws', 'pwd\n'], ['resize', 'term-ws', 100, 40], ['signal', 'term-ws', 'SIGINT'],
    ])
    active = undefined
    output.push(null)
    await within(closed, 'close frame')
    assert.ok(calls.some(value => Array.isArray(value) && value[0] === 'started'))
    assert.ok(calls.some(value => Array.isArray(value) && value[0] === 'exited'))
    assert.ok(calls.some(value => Array.isArray(value) && value[0] === 'detach'))
  } finally { client?.terminate(); await app.close() }
})

test('Vite 将终端 Cookie WebSocket 转发到 Node，并保留同源检查', async () => {
  const calls: string[] = []
  const output = queue()
  const options: Omit<TerminalWebsocketOptions, 'auth'> = {
    manager: {
      get() { return undefined }, async attach() {}, async subscribe() { return output }, async unsubscribe() { output.push(null) },
      async detach() {}, async write() {}, async resize() {}, async signal() {}, async terminate() {}, async closeAll() {},
    },
    runtime: { async read() { calls.push('read'); return { mode: 'interactive-pty', workspaceId: null } as never }, async startWithSubscription() { calls.push('start'); return { session: { handle: { pid: 1, sandboxId: 'x' }, cols: 80, rows: 24, workspaceId: null }, queue: output } } },
    state: { async started() {}, async exited() { return true } },
  }
  const app = createApp({ appName: '测试应用', isReady: async () => true,
    userAuth: { secret, async lookupUser() { return { id: owner, isActive: true, securityVersion: 1 } } },
    terminalWebsocket: options,
  })
  const webRoot = new URL('../../../web/', import.meta.url)
  const { createServer } = createRequire(new URL('package.json', webRoot))('vite') as {
    createServer(options: Record<string, unknown>): Promise<{
      listen(): Promise<void>
      close(): Promise<void>
      httpServer?: { address(): string | { port: number } | null }
    }>
  }
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  let client: WebSocket | undefined
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = address
    vite = await createServer({
      configFile: fileURLToPath(new URL('vite.config.js', webRoot)),
      root: fileURLToPath(webRoot),
      envDir: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, watch: null },
    })
    await vite.listen()
    const viteAddress = vite.httpServer?.address()
    assert.ok(viteAddress && typeof viteAddress !== 'string')
    const browserOrigin = `http://127.0.0.1:${viteAddress.port}`
    const socketUrl = `ws://127.0.0.1:${viteAddress.port}/api/v1/terminals/term-ws/ws`
    const cookie = `gugu_user_access_token=${createUserToken(owner, 1, secret)}`
    client = new WebSocket(socketUrl, { headers: { cookie, origin: 'http://untrusted.example.invalid' } })
    const [error] = await within(once(client, 'error'), '跨源拒绝')
    assert.match(String((error as Error).message), /403/)
    assert.deepEqual(calls, [])

    client = new WebSocket(socketUrl, { headers: { cookie, origin: browserOrigin } })
    const [firstFrame] = await within(once(client, 'message'), '同源终端就绪')
    assert.deepEqual(JSON.parse(String(firstFrame)), {
      type: 'ready', terminalId: 'term-ws', mode: 'interactive-pty', cols: 80, rows: 24,
    })
    assert.deepEqual(calls, ['read', 'start'])
  } finally {
    client?.terminate()
    await vite?.close()
    await app.close()
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
  }
})

test('客户端断线只释放订阅并保留 PTY，不能把 detach 当成自然 exit', async () => {
  const output = queue()
  let active: unknown
  let exited = 0
  const options: Omit<TerminalWebsocketOptions, 'auth'> = {
    manager: {
      get() { return active }, async attach() {}, async subscribe() { return output },
      async unsubscribe() { output.push(null) }, async detach() {}, async write() {}, async resize() {},
      async signal() {}, async terminate() { active = undefined }, async closeAll() { active = undefined },
    },
    runtime: {
      async read() { return { mode: 'interactive-pty', workspaceId: null } as never },
      async startWithSubscription() {
        active = { handle: { pid: 1, sandboxId: 'term-detach:1' }, cols: 80, rows: 24 }
        return { session: { handle: { pid: 1, sandboxId: 'term-detach:1' }, cols: 80, rows: 24, workspaceId: null }, queue: output }
      },
    },
    state: { async started() {}, async exited() { exited += 1; return true } },
  }
  const app = createApp({ appName: '测试应用', isReady: async () => true, userAuth: authOptions(), terminalWebsocket: options })
  let client: WebSocket | undefined
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    client = new WebSocket(`${address.replace('http://', 'ws://')}/api/v1/terminals/term-detach/ws`, [`gugu-auth.${createUserToken(owner, 1, secret)}`])
    const ready = once(client, 'message')
    await within(Promise.race([once(client, 'open'), once(client, 'error').then(([error]) => { throw error })]), 'detached open')
    await within(ready, 'detached ready')
    const closed = once(client, 'close')
    client.close()
    await within(closed, 'detached close')
    for (let attempt = 0; attempt < 20 && exited > 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(exited, 0)
    assert.ok(active)
  } finally { client?.terminate(); await app.close() }
})
