import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'

test('Vite forwards authenticated SMTP preview requests to Node Host and serves preview logo assets', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000081'
  const secret = 'synthetic-smtp-preview-vite-secret'
  const user: PublicUserRecord = {
    id: ownerId,
    username: 'smtp-preview-user',
    displayName: '邮件预览测试用户',
    email: 'smtp-preview@example.test',
    isActive: true,
    accountStatus: 'active',
    securityVersion: 1,
    avatarUrl: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    emailSubscribed: false,
    imChannels: [],
  }
  const app = createApp({
    appName: 'smtp-preview-vite-integration',
    async isReady() { return true },
    userAuth: { secret, async lookupUser(userId) { return userId === ownerId ? user : null } },
    preferences: { async read() { return {} }, async write() {} },
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
  const previousProxyTarget = process.env.VITE_API_PROXY_TARGET

  try {
    const hostAddress = await app.listen({ host: '127.0.0.1', port: 0 })
    process.env.VITE_API_PROXY_TARGET = hostAddress
    const frontendRoot = resolve(process.cwd(), '../web')
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
    const base = `http://127.0.0.1:${address.port}`
    const csrf = createCsrfToken()
    const access = createUserToken(ownerId, 1, secret)
    const headers = {
      cookie: `gugu_user_access_token=${access}; gugu_user_csrf_token=${csrf}`,
      'x-csrf-token': csrf,
    }

    const preview = await fetch(`${base}/api/v1/preferences/smtp/preview`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ template: 'reminder', theme: 'dark', palette: 'blue' }),
    })
    assert.equal(preview.status, 200)
    const html = (await preview.json() as { html: string }).html
    assert.match(html, /#9aaecd/)
    assert.match(html, /REMINDER/)

    const logo = await fetch(`${base}/logo-large2.png`)
    assert.equal(logo.status, 200)
    assert.match(logo.headers.get('content-type') ?? '', /image\/png/)
  } finally {
    if (vite) await vite.close()
    await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
  }
})
