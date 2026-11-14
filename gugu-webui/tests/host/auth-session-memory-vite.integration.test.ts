import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import type { PublicUserRecord } from '../../src/domains/auth/auth.js'

const ownerId = '4e3b3ce3-661b-4eb6-a888-e5e566983e78'
const secret = 'synthetic-vite-session-secret'

test('Vite→Node Host 支持登录、读取 Cookie 会话并在注销后拒绝旧会话', async () => {
  let securityVersion = 4
  const publishedRevocations: string[] = []
  const liveChannels: string[][] = []
  const user = (): PublicUserRecord => ({
    id: ownerId,
    username: '合成账号',
    displayName: '小北',
    email: 'synthetic@example.test',
    avatarUrl: null,
    createdAt: '2026-11-14T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    emailSubscribed: false,
    imChannels: [],
    isActive: true,
    accountStatus: 'active',
    securityVersion,
  })
  const app = createApp({
    appName: 'Node WebUI session integration',
    isReady: async () => true,
    userAuth: {
      secret,
      async lookupUser(id) { return id === ownerId ? user() : null },
      async authenticateCredentials(username, password) {
        return username === 'synthetic-user' && password === 'synthetic-password' ? user() : null
      },
      async recordLogin() {},
      async revokeUserSessions(id) {
        if (id === ownerId) securityVersion += 1
      },
      async publishAuthStateChanged(id) { publishedRevocations.push(id) },
    },
    live: {
      async subscribe(channels) {
        liveChannels.push([...channels])
        let delivered = false
        return {
          async next() {
            if (delivered) return null
            delivered = true
            return {
              channel: `events:${ownerId}`,
              data: JSON.stringify({
                protocol_version: 'live-event-v1', event_id: 'evt-synthetic-1',
                type: 'resource.changed', resource: 'files', operation: 'update',
                revision: 1, created_at: '2026-11-14T00:00:00+00:00',
              }),
            }
          },
          async close() {},
        }
      },
      async isUserActive(id, version) { return id === ownerId && version === securityVersion },
    },
  })

  let vite: {
    listen(): Promise<void>
    close(): Promise<void>
    httpServer?: { address(): string | { port: number } | null }
  } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../frontend')
    const requireFrontend = createRequire(resolve(frontendRoot, 'package.json'))
    const viteModule = requireFrontend('vite') as {
      createServer(options: Record<string, unknown>): Promise<{
        listen(): Promise<void>
        close(): Promise<void>
        httpServer?: { address(): string | { port: number } | null }
      }>
    }
    vite = await viteModule.createServer({
      configFile: resolve(frontendRoot, 'vite.config.js'),
      root: frontendRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    })
    await vite.listen()
    const address = vite.httpServer?.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/api/v1`

    const unauthenticated = await fetch(`${base}/auth/me`)
    assert.equal(unauthenticated.status, 401)
    const unauthenticatedLive = await fetch(`${base}/live/stream`)
    assert.equal(unauthenticatedLive.status, 401)

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-transport': 'cookie' },
      body: JSON.stringify({ username: 'synthetic-user', password: 'synthetic-password' }),
    })
    assert.equal(login.status, 200)
    assert.equal((await login.json() as { access_token: string | null }).access_token, null)
    const cookies = login.headers.getSetCookie()
    const accessCookie = cookies.find((cookie) => cookie.startsWith('gugu_user_access_token='))
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('gugu_user_csrf_token='))
    assert.ok(accessCookie)
    assert.ok(csrfCookie)
    assert.match(accessCookie, /HttpOnly/)
    assert.doesNotMatch(csrfCookie, /HttpOnly/)
    const cookieHeader = [accessCookie, csrfCookie].map((cookie) => cookie.split(';', 1)[0]).join('; ')

    const session = await fetch(`${base}/auth/me`, { headers: { cookie: cookieHeader } })
    assert.equal(session.status, 200)
    assert.equal((await session.json() as { id: string }).id, ownerId)

    const live = await fetch(`${base}/live/stream`, { headers: { cookie: cookieHeader } })
    assert.equal(live.status, 200)
    assert.match(live.headers.get('content-type') ?? '', /^text\/event-stream/)
    const liveBody = await live.text()
    assert.match(liveBody, /^: connected\n\ndata: /)
    assert.ok(liveBody.includes('"event_id":"evt-synthetic-1"'))
    assert.deepEqual(liveChannels, [[`events:${ownerId}`, 'events:__broadcast__']])

    const csrfToken = csrfCookie.split(';', 1)[0]!.split('=', 2)[1]!
    const logout = await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    })
    assert.equal(logout.status, 200)
    assert.deepEqual(await logout.json(), { ok: true })
    assert.equal(securityVersion, 5)
    assert.deepEqual(publishedRevocations, [ownerId])
    assert.match(logout.headers.getSetCookie().join('\n'), /gugu_user_access_token=; Max-Age=0/)

    const revokedSession = await fetch(`${base}/auth/me`, { headers: { cookie: cookieHeader } })
    assert.equal(revokedSession.status, 401)
  } finally {
    await vite?.close()
    await app.close()
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
  }
})
