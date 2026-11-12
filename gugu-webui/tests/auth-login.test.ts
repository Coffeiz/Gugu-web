import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from '../src/app.js'
import { verifyUserToken, type PublicUserRecord } from '../src/auth.js'

const secret = 'synthetic-login-secret-with-enough-entropy'
const userId = '9e51a4bf-07e1-4db8-9050-54a8c7356e8d'

function makeApp(options: { transport?: string; user?: Partial<PublicUserRecord> } = {}) {
  const calls: unknown[][] = []
  const app = createApp({
    appName: 'Gugu',
    isReady: async () => true,
    userAuth: {
      secret,
      lookupUser: async () => null,
      authenticateCredentials: async (username, password) => {
        calls.push(['authenticateCredentials', username, password])
        return username === 'synthetic-user' && password === 'valid-password'
          ? {
            id: userId,
            username: 'synthetic-user',
            displayName: 'Synthetic',
            email: 'synthetic@example.test',
            isActive: true,
            securityVersion: 3,
            avatarUrl: null,
            createdAt: '2026-11-01T00:00:00.000Z',
            timezone: 'Asia/Shanghai',
            emailSubscribed: false,
            imChannels: ['qq'],
            ...options.user,
          }
          : null
      },
      recordLogin: async (id) => { calls.push(['recordLogin', id]) },
    },
  })
  return { app, calls, transport: options.transport }
}

test('password login signs a compatible token, records activity, and returns the public user shape', async () => {
  const { app, calls } = makeApp()
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { username: 'synthetic-user', password: 'valid-password' },
    })

    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.token_type, 'bearer')
    assert.equal(body.user.id, userId)
    assert.equal(body.user.display_name, 'Synthetic')
    assert.equal(body.user.im_channels[0], 'qq')
    assert.equal(verifyUserToken(body.access_token, secret).securityVersion, 3)
    assert.deepEqual(calls, [
      ['authenticateCredentials', 'synthetic-user', 'valid-password'],
      ['recordLogin', userId],
    ])
  } finally {
    await app.close()
  }
})

test('cookie login omits the token from JSON and sets HttpOnly access plus readable CSRF cookies', async () => {
  const { app } = makeApp()
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      headers: { 'x-auth-transport': 'cookie', 'x-forwarded-proto': 'https' },
      payload: { username: 'synthetic-user', password: 'valid-password' },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().access_token, null)
    const cookies = response.headers['set-cookie']
    assert.ok(cookies)
    const values = Array.isArray(cookies) ? cookies : [cookies]
    assert.match(values.join('\n'), /gugu_user_access_token=.*HttpOnly;.*Secure;.*SameSite=Lax/)
    assert.match(values.join('\n'), /gugu_user_csrf_token=.*Secure;.*SameSite=Lax/)
  } finally {
    await app.close()
  }
})

test('login preserves invalid credentials and disabled account status responses', async () => {
  const { app } = makeApp({ user: {
    id: userId,
    username: 'synthetic-user',
    displayName: null,
    email: 'synthetic@example.test',
    isActive: false,
    securityVersion: 1,
    avatarUrl: null,
    createdAt: null,
    timezone: null,
    emailSubscribed: false,
    imChannels: [],
  } })
  try {
    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { username: 'unknown-user', password: 'wrong-password' },
    })
    const disabled = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { username: 'synthetic-user', password: 'valid-password' },
    })
    const malformed = await app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { username: '', password: 3 },
    })

    assert.equal(invalid.statusCode, 401)
    assert.deepEqual(invalid.json(), { detail: '用户名或密码错误' })
    assert.equal(disabled.statusCode, 403)
    assert.deepEqual(disabled.json(), { detail: '账号已停用，请联系管理员' })
    assert.equal(malformed.statusCode, 422)
  } finally {
    await app.close()
  }
})

test('login blocks the eleventh attempt for the same forwarded peer and account', async () => {
  const { app, calls } = makeApp()
  try {
    const responses = []
    for (let attempt = 0; attempt < 11; attempt += 1) {
      responses.push(await app.inject({
        method: 'POST', url: '/api/v1/auth/login',
        headers: { 'x-forwarded-for': `untrusted-${attempt}, 198.51.100.7` },
        payload: { username: 'rate-limit-user', password: 'wrong-password' },
      }))
    }
    assert.ok(responses.slice(0, 10).every((response) => response.statusCode === 401))
    assert.equal(responses[10]?.statusCode, 429)
    assert.equal(calls.filter(([operation]) => operation === 'authenticateCredentials').length, 10)
  } finally {
    await app.close()
  }
})
