import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { parseCookieHeader } from '../../http/cookies.js'

export type AdminRole = 'superadmin' | 'admin'

export interface AdminIdentity {
  readonly username: string
  readonly role: AdminRole
  readonly authVersion: number
}

export interface AdminAuthOptions {
  readonly username?: string | null
  readonly password: string
  readonly secret: string
  readonly tokenExpiresMinutes: number
  readonly getAuthVersion: () => Promise<number>
  readonly incrementAuthVersion: () => Promise<number>
  readonly rateLimit: (
    request: FastifyRequest,
    bucket: 'adminlogin',
    limit: 10,
    windowSeconds: 300,
  ) => Promise<void>
  readonly hostGuard: preHandlerHookHandler
  readonly audit?: (
    username: string,
    action: 'login',
    detail: string,
    request: FastifyRequest,
  ) => Promise<unknown>
  readonly now?: () => number
}

declare module 'fastify' {
  interface FastifyRequest {
    adminIdentity?: AdminIdentity
  }
}

export class AdminAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 403 | 422 | 429 | 503,
  ) {
    super(message)
    this.name = 'AdminAuthError'
  }
}

const accessCookie = 'gugu_admin_access_token'
const csrfCookie = 'gugu_admin_csrf_token'
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])
const authVersionRange = 2 ** 48

/**
 * 单进程 Node Host 使用进程内认证版本；启动时随机生成版本，让重启前签发的 Admin token 失效。
 * 多实例部署需要改用共享版本存储。
 */
export function createInMemoryAdminAuthVersionStore(initialVersion = randomBytes(6).readUIntBE(0, 6)) {
  if (!Number.isSafeInteger(initialVersion) || initialVersion < 0 || initialVersion >= authVersionRange)
    throw new Error('管理员认证版本无效')

  let version = initialVersion
  return {
    async getAuthVersion(): Promise<number> {
      return version
    },
    async incrementAuthVersion(): Promise<number> {
      version = version + 1 < authVersionRange ? version + 1 : randomBytes(6).readUIntBE(0, 6)
      return version
    },
  }
}

interface TokenPayload {
  readonly sub?: unknown
  readonly role?: unknown
  readonly av?: unknown
  readonly exp?: unknown
}

interface DecodedAdminIdentity {
  readonly username: string
  readonly role: AdminRole
  readonly authVersion: number
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function requestToken(request: FastifyRequest): string {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer) return bearer

  const cookies = parseCookieHeader(request.headers.cookie)
  const token = cookies.get(accessCookie)
  if (!token) throw new AdminAuthError('未提供认证凭据', 401)
  if (!safeMethods.has(request.method.toUpperCase())) {
    const csrfCookieValue = cookies.get(csrfCookie)
    const csrfHeader = request.headers['x-csrf-token']
    if (!csrfCookieValue || typeof csrfHeader !== 'string' || !constantTimeEqual(csrfCookieValue, csrfHeader))
      throw new AdminAuthError('CSRF 校验失败', 403)
  }
  return token
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid JWT segment')
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
}

function decodeAdminToken(token: string, secret: string, now: number): DecodedAdminIdentity {
  const parts = token.split('.')
  if (parts.length !== 3 || !secret) throw new Error('invalid JWT shape')
  const header = decodeSegment(parts[0])
  const payload = decodeSegment(parts[1]) as TokenPayload
  if (!header || typeof header !== 'object' || (header as Record<string, unknown>).alg !== 'HS256')
    throw new Error('unsupported JWT algorithm')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid JWT claims')

  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()
  const provided = Buffer.from(parts[2], 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw new Error('invalid JWT signature')
  if (payload.exp !== undefined && (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now / 1000))
    throw new Error('expired JWT')

  if (payload.role !== 'superadmin' && payload.role !== 'admin')
    throw new AdminAuthError('权限不足', 403)
  if (typeof payload.sub !== 'string' || !payload.sub)
    throw new Error('invalid admin subject')
  const authVersion = payload.av === undefined ? 0 : Number(payload.av)
  if (!Number.isSafeInteger(authVersion) || authVersion < 0) throw new Error('invalid admin auth version')
  return { username: payload.sub, role: payload.role, authVersion }
}

function signAdminToken(
  username: string,
  role: AdminRole,
  authVersion: number,
  secret: string,
  now: number,
  expiresInMinutes: number,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    role,
    exp: Math.floor(now / 1000) + expiresInMinutes * 60,
    iat: Math.floor(now / 1000),
    av: authVersion,
  })).toString('base64url')
  const content = `${header}.${payload}`
  const signature = createHmac('sha256', secret).update(content).digest('base64url')
  return `${content}.${signature}`
}

function parseLoginBody(body: unknown): { username: string; password: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  if (typeof value.username !== 'string' || typeof value.password !== 'string') return null
  return { username: value.username, password: value.password }
}

function setAdminCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
  csrf: string,
  maxAge: number,
): void {
  const forwardedProtocol = request.headers['x-forwarded-proto']
  const secure = request.protocol === 'https'
    || (typeof forwardedProtocol === 'string'
      && forwardedProtocol.split(',', 1)[0]?.trim().toLowerCase() === 'https')
  const secureSuffix = secure ? '; Secure' : ''
  reply.header('set-cookie', [
    `${accessCookie}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly${secureSuffix}; SameSite=Lax`,
    `${csrfCookie}=${csrf}; Max-Age=${maxAge}; Path=/${secureSuffix}; SameSite=Lax`,
  ])
}

function clearAdminCookies(reply: FastifyReply): void {
  reply.header('set-cookie', [
    `${accessCookie}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
    `${csrfCookie}=; Max-Age=0; Path=/; SameSite=Lax`,
  ])
}

function sendAuthError(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof AdminAuthError)) return false
  reply.code(error.statusCode).send({ detail: error.message })
  return true
}

export interface AdminAuthAdapter {
  registerRoutes(app: FastifyInstance): void
  requireAdmin: preHandlerHookHandler
  /** 供长连接轮询重新校验 token、管理员角色与当前 auth-version。 */
  verifyAdmin(request: FastifyRequest): Promise<boolean>
}

export function createAdminAuthAdapter(options: AdminAuthOptions): AdminAuthAdapter {
  const username = options.username || 'admin'
  const now = options.now ?? Date.now
  let passwordHash: Promise<string> | undefined

  async function currentAuthVersion(): Promise<number> {
    try {
      const version = await options.getAuthVersion()
      if (!Number.isSafeInteger(version) || version < 0) throw new Error('invalid admin auth version')
      return version
    } catch {
      throw new AdminAuthError('管理员认证服务暂不可用', 503)
    }
  }

  async function authenticatedToken(
    request: FastifyRequest,
    roleFailureStatus: 403 | 503 = 403,
  ): Promise<DecodedAdminIdentity> {
    let token: string
    try {
      token = requestToken(request)
    } catch (error) {
      if (error instanceof AdminAuthError) throw error
      throw new AdminAuthError('Token 无效或已过期', 401)
    }

    let identity: DecodedAdminIdentity
    try {
      identity = decodeAdminToken(token, options.secret, now())
    } catch (error) {
      if (error instanceof AdminAuthError) {
        if (error.statusCode === 403 && roleFailureStatus === 503)
          throw new AdminAuthError('管理员认证服务暂不可用', 503)
        throw error
      }
      throw new AdminAuthError('Token 无效或已过期', 401)
    }
    if (identity.authVersion !== await currentAuthVersion())
      throw new AdminAuthError('Token 无效或已撤销', 401)
    return identity
  }

  const requireAdmin: preHandlerHookHandler = async (request, reply) => {
    await options.hostGuard.call(request.server, request, reply, () => {})
    if (reply.sent) return
    try {
      const identity = await authenticatedToken(request)
      request.adminIdentity = identity
    } catch (error) {
      if (!sendAuthError(reply, error)) throw error
    }
  }

  async function verifyAdmin(request: FastifyRequest): Promise<boolean> {
    try {
      await authenticatedToken(request)
      return true
    } catch {
      return false
    }
  }

  async function audit(username: string, detail: string, request: FastifyRequest): Promise<void> {
    try {
      await options.audit?.(username, 'login', detail, request)
    } catch {
      // Audit is best effort in the Python admin-auth contract.
    }
  }

  return {
    requireAdmin,
    verifyAdmin,
    registerRoutes(app) {
      app.post('/api/v1/admin/auth/login', { preHandler: options.hostGuard }, async (request, reply) => {
        const input = parseLoginBody(request.body)
        if (!input) return reply.code(422).send({ detail: '登录请求字段无效' })
        try {
          await options.rateLimit(request, 'adminlogin', 10, 300)
        } catch (error) {
          if (sendAuthError(reply, error)) return
          throw error
        }

        if (!options.password)
          return reply.code(503).send({ detail: '管理员密码未配置，请先设置 ADMIN_PASSWORD' })

        passwordHash ??= bcrypt.hash(options.password, 12)
        const hash = await passwordHash
        const matches = input.username === username && await bcrypt.compare(input.password, hash)
        if (!matches) {
          await audit(input.username, '登录失败：用户名或密码错误', request)
          return reply.code(401).send({ detail: '用户名或密码错误' })
        }

        let authVersion: number
        try {
          authVersion = await currentAuthVersion()
        } catch (error) {
          if (sendAuthError(reply, error)) return
          throw error
        }
        const token = signAdminToken(username, 'superadmin', authVersion, options.secret, now(), options.tokenExpiresMinutes)
        const csrf = randomBytes(32).toString('base64url')
        setAdminCookies(request, reply, token, csrf, options.tokenExpiresMinutes * 60)
        await audit(username, '登录成功', request)
        const result: Record<string, unknown> = { user: { username, role: 'superadmin' } }
        if (request.headers['x-auth-transport'] !== 'cookie') {
          result.access_token = token
          result.token_type = 'bearer'
        }
        return result
      })

      app.post('/api/v1/admin/auth/logout', { preHandler: options.hostGuard }, async (request, reply) => {
        try {
          await authenticatedToken(request, 503)
          try {
            await options.incrementAuthVersion()
          } catch {
            throw new AdminAuthError('管理员认证服务暂不可用', 503)
          }
          clearAdminCookies(reply)
          return { ok: true }
        } catch (error) {
          if (sendAuthError(reply, error)) return
          throw error
        }
      })

      app.get('/api/v1/admin/auth/me', { preHandler: options.hostGuard }, async (request, reply) => {
        try {
          const identity = await authenticatedToken(request)
          return { username: identity.username, role: identity.role }
        } catch (error) {
          if (sendAuthError(reply, error)) return
          throw error
        }
      })
    },
  }
}
