import { createHmac, timingSafeEqual } from 'node:crypto'

const accessCookie = 'gugu_user_access_token'
const csrfCookie = 'gugu_user_csrf_token'
const csrfHeader = 'x-csrf-token'
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class AuthenticationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 403 = 401,
  ) {
    super(message)
    this.name = 'AuthenticationError'
  }
}

export interface UserIdentity {
  readonly userId: string
  readonly securityVersion: number
}

export interface AuthenticatedUserRecord {
  readonly id: string
  readonly isActive: boolean
  readonly accountStatus?: string | null
  readonly securityVersion?: number | null
}

export interface PublicUserRecord extends AuthenticatedUserRecord {
  readonly username: string
  readonly displayName: string | null
  readonly email: string
  readonly avatarUrl: string | null
  readonly createdAt: string | Date | null
  readonly timezone: string | null
  readonly emailSubscribed: boolean
  readonly imChannels: readonly string[]
}

export interface AuthRequest {
  readonly method: string
  readonly authorization?: string
  readonly cookie?: string
  readonly csrfHeader?: string
}

function cookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>()
  for (const item of header?.split(';') ?? []) {
    const separator = item.indexOf('=')
    if (separator < 0) continue
    const name = item.slice(0, separator).trim()
    const value = item.slice(separator + 1).trim()
    if (name && !result.has(name)) result.set(name, value)
  }
  return result
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function extractUserToken(request: AuthRequest): string {
  const match = request.authorization?.match(/^Bearer\s+(.+)$/i)
  if (match?.[1]) return match[1]

  const cookieValues = cookies(request.cookie)
  const token = cookieValues.get(accessCookie)
  if (!token) throw new AuthenticationError('未提供认证凭据')

  if (!safeMethods.has(request.method.toUpperCase())) {
    const csrfValue = cookieValues.get(csrfCookie)
    if (!csrfValue || !request.csrfHeader || !constantTimeEqual(csrfValue, request.csrfHeader)) {
      throw new AuthenticationError('CSRF 校验失败', 403)
    }
  }
  return token
}

function decodeSegment(segment: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid base64url segment')
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
}

function verifySignature(token: string, secret: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3 || !secret) throw new Error('invalid token shape')
  const header = decodeSegment(parts[0])
  const payload = decodeSegment(parts[1])
  if (!header || typeof header !== 'object' || (header as Record<string, unknown>).alg !== 'HS256')
    throw new Error('invalid signing algorithm')
  if (!payload || typeof payload !== 'object') throw new Error('invalid token claims')

  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()
  const provided = Buffer.from(parts[2], 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw new Error('invalid signature')
  return payload as Record<string, unknown>
}

function identityFromClaims(claims: Record<string, unknown>, nowMs: number): UserIdentity {
  if (claims.role !== 'user' || typeof claims.sub !== 'string' || !uuidPattern.test(claims.sub))
    throw new Error('invalid identity claims')
  if (claims.exp !== undefined && (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowMs / 1000))
    throw new Error('expired token')

  const securityVersion = claims.sv === undefined ? 1 : Number(claims.sv)
  if (!Number.isSafeInteger(securityVersion) || securityVersion < 1) throw new Error('invalid security version')
  return { userId: claims.sub.toLowerCase(), securityVersion }
}

export function verifyUserToken(token: string, secret: string, nowMs = Date.now()): UserIdentity {
  try {
    return identityFromClaims(verifySignature(token, secret), nowMs)
  } catch {
    throw new AuthenticationError('Token 无效或已过期')
  }
}

export async function authenticateUser<T extends AuthenticatedUserRecord>(
  request: AuthRequest,
  secret: string,
  lookupUser: (userId: string) => Promise<T | null>,
): Promise<{ identity: UserIdentity; user: T }> {
  const identity = verifyUserToken(extractUserToken(request), secret)
  const user = await lookupUser(identity.userId)
  const active = user && user.isActive && (user.accountStatus ?? 'active') === 'active'
  const securityVersion = user?.securityVersion || 1
  if (!active || securityVersion !== identity.securityVersion)
    throw new AuthenticationError('用户不存在或已停用')
  return { identity, user }
}
