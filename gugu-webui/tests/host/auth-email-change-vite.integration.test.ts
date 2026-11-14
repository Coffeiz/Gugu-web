import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { createApp } from '../../src/app.js'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../../src/domains/auth/auth.js'
import { hashEmailChangeToken, type EmailChangeStore, type EmailChangeUser } from '../../src/domains/auth/email-change.js'

const ownerId = '3c392b91-07b0-4c36-8f7f-1a2c611f7480'
const secret = 'synthetic-email-change-vite-secret'
const token = 'synthetic-email-change-vite-token-0123456789'

test('Vite routes authenticated email-change request and public verification through Node Host', async () => {
  let email = 'cedarz@example.test'
  let requestTokenHash = ''
  const sentLinks: string[] = []
  const published: string[] = []
  let writes = 0
  const passwordHash = await bcrypt.hash('synthetic-current-password', 4)
  const user: EmailChangeUser = {
    id: ownerId, email, username: 'reset-user', displayName: '小北', passwordHash,
  }
  const store: EmailChangeStore = {
    async findUser(userId) { return userId === ownerId ? { ...user, email } : null },
    async emailOccupied(candidate) { return candidate === email },
    async createRequest(_userId, nextEmail, tokenHash) {
      requestTokenHash = tokenHash
      sentLinks.push(`${nextEmail}`)
      writes += 1
    },
    async activeRequest() { return null },
    async replaceActiveToken() { return null },
    async revokeActive() {},
    async completeToken(tokenHash) {
      if (tokenHash !== requestTokenHash) return { kind: 'invalid' }
      email = 'fresh@example.test'
      return { kind: 'completed', user: { ...user, email } }
    },
  }
  const publicUser: PublicUserRecord = {
    id: ownerId, username: 'reset-user', displayName: '小北', email, isActive: true,
    accountStatus: 'active', securityVersion: 4, avatarUrl: null, createdAt: new Date(),
    timezone: 'UTC', emailSubscribed: false, imChannels: [],
  }
  const app = createApp({
    appName: 'auth-email-change-vite-host',
    async isReady() { return true },
    userAuth: { secret, async lookupUser(userId) { return userId === ownerId ? publicUser : null } },
    emailChange: {
      store,
      async rateLimit() {},
      systemEmailAvailable: true,
      publicAppUrl: 'https://gugu.example.test',
      mail: {
        async sendVerification({ link }) { sentLinks.push(link); return true },
        async sendNotice() { return true },
      },
      async publishAuthStateChanged(userId) { published.push(userId) },
      createToken: () => token,
    },
  })
  let vite: { listen(): Promise<void>; close(): Promise<void>; httpServer?: { address(): string | { port: number } | null } } | undefined
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
    const endpoint = `http://127.0.0.1:${address.port}/api/v1/auth/email-change`
    const unauthorized = await fetch(`${endpoint}/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ newEmail: 'fresh@example.test', currentPassword: 'synthetic-current-password' }),
    })
    assert.equal(unauthorized.status, 401)
    assert.equal(writes, 0)

    const csrf = createCsrfToken()
    const cookie = `gugu_user_access_token=${createUserToken(ownerId, 4, secret)}; gugu_user_csrf_token=${csrf}`
    const request = await fetch(`${endpoint}/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ newEmail: 'fresh@example.test', currentPassword: 'synthetic-current-password' }),
    })
    assert.equal(request.status, 200)
    assert.equal(writes, 1)
    assert.ok(sentLinks.includes(`https://gugu.example.test/verify-email-change?token=${token}`))

    const verify = await fetch(`${endpoint}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
    })
    assert.equal(verify.status, 200)
    assert.equal(email, 'fresh@example.test')
    assert.deepEqual(published, [ownerId])
    assert.equal(requestTokenHash, hashEmailChangeToken(token))
  } finally {
    if (vite) await vite.close()
    await app.close().catch(() => undefined)
    if (previousProxyTarget === undefined) delete process.env.VITE_API_PROXY_TARGET
    else process.env.VITE_API_PROXY_TARGET = previousProxyTarget
  }
})
