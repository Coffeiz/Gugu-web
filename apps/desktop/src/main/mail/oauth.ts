import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mailStoredAccount, type MailAccount, type MailOAuthProvider } from '@gugu/email/contracts'
import { MailError } from '@gugu/email/service'

const providers = {
  outlook: {
    authorization: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
    redirectHost: 'localhost',
    imapHost: 'outlook.office365.com', smtpHost: 'smtp.office365.com', smtpPort: 587,
  },
  gmail: {
    authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope: 'https://mail.google.com/',
    redirectHost: '127.0.0.1',
    imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465,
  },
} as const
const callbackPath = '/mail/oauth'
type Credential = NonNullable<MailAccount['oauth']>
type Client = { id: string; secret?: string }
type Token = { accessToken: string; refreshToken?: string; expiresAt: number }

export function createDesktopMailOAuth(options: {
  openBrowser(url: string): Promise<void>
  clients: Partial<Record<MailOAuthProvider, Client>>
  fetch?: typeof fetch
  updateCredential(accountId: string, previous: Credential, refreshToken: string): Promise<void>
}) {
  const request = options.fetch ?? fetch
  const cached = new Map<string, Token>()
  const refreshing = new Map<string, Promise<string>>()
  let connecting = false

  async function exchange(provider: MailOAuthProvider, parameters: Record<string, string>): Promise<Token> {
    const client = options.clients[provider]
    if (!client) throw new MailError(409, '邮箱授权客户端未配置')
    let response: Response
    try {
      response = await request(providers[provider].token, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({ client_id: client.id, ...parameters,
          ...(client.secret ? { client_secret: client.secret } : {}) }),
      })
      if (!response.ok) throw new Error()
      const result = await response.json() as Partial<Record<'access_token' | 'refresh_token' | 'expires_in', unknown>>
      if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 16384
        || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0)
        throw new Error()
      return {
        accessToken: result.access_token,
        refreshToken: typeof result.refresh_token === 'string' && result.refresh_token.length <= 16384
          ? result.refresh_token : undefined,
        expiresAt: Date.now() + Math.min(result.expires_in, 86400) * 1000,
      }
    } catch {
      throw new MailError(409, '邮箱授权已失效或暂不可用，请重新连接')
    }
  }

  async function authorize(provider: MailOAuthProvider, email: string, accountId?: string) {
    const client = options.clients[provider]
    if (!client) throw new MailError(409, '邮箱授权客户端未配置')
    if (connecting) throw new MailError(409, '已有邮箱正在授权，请先完成该操作')
    connecting = true
    const config = providers[provider]
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const abort = AbortSignal.timeout(180_000)
    let receive: (code: string | null) => void = () => {}
    const callback = new Promise<string | null>(resolve => { receive = resolve })
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || !req.url?.startsWith(callbackPath + '?')) {
        res.writeHead(404).end()
        return
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.searchParams.get('state') !== state) {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', Connection: 'close' })
        .end(code ? '授权已返回，请回到咕咕完成邮箱连接。' : '授权未完成，请回到咕咕重试。')
      receive(code)
    })
    const expire = () => receive(null)
    abort.addEventListener('abort', expire, { once: true })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const port = (server.address() as AddressInfo).port
      const redirectUri = `http://${config.redirectHost}:${port}${callbackPath}`
      const url = new URL(config.authorization)
      url.search = new URLSearchParams({
        client_id: client.id, redirect_uri: redirectUri, response_type: 'code',
        scope: config.scope, state, code_challenge: challenge, code_challenge_method: 'S256', login_hint: email,
        ...(provider === 'gmail' ? { access_type: 'offline', prompt: 'consent' } : { prompt: 'select_account' }),
      }).toString()
      await options.openBrowser(url.href)
      const code = await callback
      if (!code) throw new MailError(409, '邮箱授权已取消或超时')
      const token = await exchange(provider, { grant_type: 'authorization_code', code,
        redirect_uri: redirectUri, code_verifier: verifier })
      if (!token.refreshToken) throw new MailError(409, '服务商没有返回长期授权，请重新授权')
      const account = mailStoredAccount.parse({
        id: accountId ?? randomUUID(), email, username: email, password: '',
        imapHost: config.imapHost,
        smtpHost: provider === 'outlook' && /@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(email)
          ? 'smtp-mail.outlook.com' : config.smtpHost,
        smtpPort: config.smtpPort,
        oauth: { provider, credentialId: randomUUID(), clientId: client.id, refreshToken: token.refreshToken },
      })
      cached.set(account.oauth!.credentialId, token)
      return account
    } finally {
      abort.removeEventListener('abort', expire)
      server.close()
      server.closeAllConnections()
      connecting = false
    }
  }

  async function accessToken(account: MailAccount) {
    const credential = account.oauth
    if (!credential || options.clients[credential.provider]?.id !== credential.clientId)
      throw new MailError(409, '邮箱授权客户端已变化，请重新连接')
    const { credentialId, provider, refreshToken } = credential
    const token = cached.get(credentialId)
    if (token && token.expiresAt > Date.now() + 60_000) return token.accessToken
    let pending = refreshing.get(credentialId)
    if (!pending) {
      pending = exchange(provider, { grant_type: 'refresh_token', refresh_token: refreshToken })
        .then(async next => {
          if (next.refreshToken && next.refreshToken !== refreshToken)
            await options.updateCredential(account.id, credential, next.refreshToken)
          cached.set(credentialId, next)
          return next.accessToken
        }).finally(() => { refreshing.delete(credentialId) })
      refreshing.set(credentialId, pending)
    }
    return pending
  }

  return { authorize, accessToken, available: () => Object.keys(options.clients),
    forget(account?: MailAccount | null) { if (account?.oauth) cached.delete(account.oauth.credentialId) } }
}
