import { createHash, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { summarizeMailAccount } from '@gugu/email/contracts'
import { createDesktopMailOAuth } from '../src/main/mail/oauth.js'

it.each(['outlook', 'gmail'] as const)('桌面邮箱以 PKCE 连接 %s，回调检查 state 并隐藏令牌', async provider => {
  let challenge: string | null = null
  let redirectUri: string | null = null
  const tokenEndpoint = vi.fn<typeof fetch>(async (_input, init) => {
    const body = init?.body as URLSearchParams
    expect(init?.redirect).toBe('error')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe(redirectUri)
    expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge)
    return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600 })
  })
  const oauth = createDesktopMailOAuth({
    clients: { [provider]: { id: 'synthetic-client' } },
    fetch: tokenEndpoint,
    async openBrowser(address) {
      const url = new URL(address)
      challenge = url.searchParams.get('code_challenge')
      redirectUri = url.searchParams.get('redirect_uri')
      const callback = new URL(redirectUri!)
      callback.hostname = '127.0.0.1'
      callback.searchParams.set('code', 'synthetic-code')
      callback.searchParams.set('state', 'invalid')
      expect((await fetch(callback)).status).toBe(404)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      expect((await fetch(callback)).status).toBe(200)
    },
    updateCredential: vi.fn(),
  })
  const account = await oauth.authorize(provider, 'sample@example.test')
  expect(await oauth.accessToken(account)).toBe('synthetic-access')
  expect(tokenEndpoint).toHaveBeenCalledTimes(1)
  const summary = summarizeMailAccount(account)
  expect(summary).toMatchObject({ email: 'sample@example.test', oauthProvider: provider })
  expect(summary).not.toHaveProperty('oauth')
  expect(summary).not.toHaveProperty('password')
})

it('并行访问同一邮箱时共用一次刷新并持久化轮换令牌', async () => {
  const exchange = vi.fn<typeof fetch>(async () =>
    Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }))
  const updateCredential = vi.fn(async () => {})
  const oauth = createDesktopMailOAuth({
    clients: { outlook: { id: 'synthetic-client' } }, fetch: exchange,
    openBrowser: async () => {}, updateCredential,
  })
  const credential = { provider: 'outlook' as const, clientId: 'synthetic-client', credentialId: randomUUID(), refreshToken: 'old-refresh' }
  const account = { id: randomUUID(), email: 'sample@example.test', username: 'sample@example.test', password: '',
    imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', smtpPort: 587 as const, oauth: credential }
  expect(await Promise.all([oauth.accessToken(account), oauth.accessToken(account)])).toEqual(['new-access', 'new-access'])
  expect(exchange).toHaveBeenCalledTimes(1)
  expect(updateCredential).toHaveBeenCalledExactlyOnceWith(account.id, credential, 'new-refresh')
})
