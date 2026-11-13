import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../auth.js'
import { InvalidEmailError, normalizeEmail } from '../email.js'

export interface RegistrationRateLimit {
  readonly bucket: 'register'
  readonly limit: 10
  readonly windowSeconds: 3600
  readonly deviceLimit: 5
  readonly deviceWindowSeconds: 86400
  readonly failClosed: true
}

export interface RegistrationInput {
  readonly username: string
  readonly email: string
  readonly hashedPassword: string
  readonly displayName: string
  readonly emailSubscribed: boolean
  readonly locale?: 'zh-CN' | 'ja-JP' | 'en-US'
}

export interface RegistrationCodeProof {
  readonly email: string
  readonly code: string
}

export interface RegisterUserRouteOptions {
  readonly secret: string
  /** True only when the registration-verification switch and system SMTP are both available. */
  readonly verificationRequired: boolean
  readonly rateLimit: (request: FastifyRequest, options: RegistrationRateLimit) => Promise<void>
  readonly userExists: (username: string, normalizedEmail: string) => Promise<boolean>
  /** Must enforce attempts and compare the stored HMAC code digest. */
  readonly verifyRegistrationCode: (normalizedEmail: string, code: string) => Promise<boolean>
  /**
   * Must persist user, optional locale preference, default Workspace rows and binding in one PG
   * transaction. If proof is non-null, it must atomically consume that exact code before commit
   * and restore its remaining TTL after a failed commit without overwriting a newer code.
   */
  readonly registerUser: (
    input: RegistrationInput,
    proof: RegistrationCodeProof | null,
  ) => Promise<PublicUserRecord>
  /** Best-effort onboarding seed, invoked after the registration transaction commits. */
  readonly seedUser: (user: PublicUserRecord, locale?: 'zh-CN' | 'ja-JP' | 'en-US') => Promise<void>
  readonly tokenExpiresMinutes?: number
  readonly now?: () => number
}

export class RegistrationRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 422 | 429 | 503,
  ) {
    super(message)
    this.name = 'RegistrationRequestError'
  }
}

interface ParsedRegistration {
  username: string
  email: string
  password: string
  emailSubscribed: boolean
  locale?: 'zh-CN' | 'ja-JP' | 'en-US'
  verificationCode?: string
}

function readField(body: Record<string, unknown>, camel: string, snake: string): unknown {
  return body[camel] === undefined ? body[snake] : body[camel]
}

function parseRegistration(body: unknown): ParsedRegistration | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = body as Record<string, unknown>
  const username = value.username
  const email = value.email
  const password = value.password
  const emailSubscribed = readField(value, 'emailSubscribed', 'email_subscribed')
  const locale = value.locale
  const verificationCode = readField(value, 'verificationCode', 'verification_code')
  if (typeof username !== 'string' || typeof email !== 'string' || typeof password !== 'string') return null
  if (email.length < 3 || email.length > 300) return null
  if (emailSubscribed !== undefined && typeof emailSubscribed !== 'boolean') return null
  if (locale !== undefined && locale !== null && locale !== 'zh-CN' && locale !== 'ja-JP' && locale !== 'en-US') return null
  if (verificationCode !== undefined && verificationCode !== null
    && (typeof verificationCode !== 'string' || !/^\d{6}$/.test(verificationCode))) return null
  return {
    username,
    email,
    password,
    emailSubscribed: emailSubscribed === undefined ? false : emailSubscribed as boolean,
    ...(locale === undefined || locale === null ? {} : { locale }),
    ...(typeof verificationCode === 'string' ? { verificationCode } : {}),
  }
}

function responseUser(user: PublicUserRecord) {
  const createdAt = user.createdAt instanceof Date
    ? user.createdAt.toISOString().slice(0, 10)
    : user.createdAt?.slice(0, 10) ?? ''
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    email: user.email,
    is_active: user.isActive,
    avatar_url: user.avatarUrl,
    created_at: createdAt,
    im_channels: user.imChannels,
    timezone: user.timezone,
    email_subscribed: user.emailSubscribed,
  }
}

function failure(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof RegistrationRequestError)) return false
  reply.code(error.statusCode).send({ detail: error.message })
  return true
}

export function registerUserRoute(app: FastifyInstance, options: RegisterUserRouteOptions): void {
  const now = options.now ?? Date.now
  const tokenExpiresMinutes = options.tokenExpiresMinutes ?? 10080
  app.post('/api/v1/auth/register', async (request, reply) => {
    const body = parseRegistration(request.body)
    if (!body) return reply.code(422).send({ detail: '注册请求字段无效' })

    try {
      await options.rateLimit(request, {
        bucket: 'register', limit: 10, windowSeconds: 3600,
        deviceLimit: 5, deviceWindowSeconds: 86400, failClosed: true,
      })
    } catch (error) {
      if (failure(reply, error)) return
      return reply.code(503).send({ detail: '注册服务暂不可用，请稍后重试' })
    }

    let email: string
    try {
      email = normalizeEmail(body.email)
    } catch (error) {
      if (error instanceof InvalidEmailError)
        return reply.code(400).send({ detail: error.message })
      if (failure(reply, error)) return
      throw error
    }

    if (await options.userExists(body.username, email))
      return reply.code(400).send({ detail: '用户名或邮箱已被注册' })

    let proof: RegistrationCodeProof | null = null
    if (options.verificationRequired) {
      if (!body.verificationCode)
        return reply.code(400).send({ detail: '请先完成邮箱验证码验证' })
      try {
        if (!await options.verifyRegistrationCode(email, body.verificationCode))
          return reply.code(400).send({ detail: '验证码错误或已过期' })
      } catch {
        return reply.code(503).send({ detail: '验证码服务暂不可用，请稍后重试' })
      }
      proof = { email, code: body.verificationCode }
    }

    const input: RegistrationInput = {
      username: body.username,
      email,
      hashedPassword: await bcrypt.hash(body.password, 12),
      displayName: body.username,
      emailSubscribed: body.emailSubscribed,
      ...(body.locale ? { locale: body.locale } : {}),
    }

    let user: PublicUserRecord
    try {
      user = await options.registerUser(input, proof)
    } catch (error) {
      if (failure(reply, error)) return
      throw error
    }

    try {
      await options.seedUser(user, body.locale)
    } catch {
      // Onboarding is best effort after the account transaction has committed.
    }

    const securityVersion = user.securityVersion || 1
    const token = createUserToken(user.id, securityVersion, options.secret, now(), tokenExpiresMinutes)
    const forwardedProtocol = request.headers['x-forwarded-proto']
    const secure = request.protocol === 'https'
      || (typeof forwardedProtocol === 'string'
        && forwardedProtocol.split(',', 1)[0]?.trim().toLowerCase() === 'https')
    const secureSuffix = secure ? '; Secure' : ''
    const csrf = createCsrfToken()
    reply.header('set-cookie', [
      `gugu_user_access_token=${token}; Max-Age=${tokenExpiresMinutes * 60}; Path=/; HttpOnly${secureSuffix}; SameSite=Lax`,
      `gugu_user_csrf_token=${csrf}; Max-Age=${tokenExpiresMinutes * 60}; Path=/${secureSuffix}; SameSite=Lax`,
    ])
    return reply.code(201).send({
      access_token: request.headers['x-auth-transport'] === 'cookie' ? null : token,
      token_type: 'bearer',
      user: responseUser(user),
    })
  })
}
