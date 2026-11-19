import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createCsrfToken, createUserToken, type PublicUserRecord } from '../session/token.js'
import { InvalidEmailError, normalizeEmail } from '../email.js'
import { RateLimitError, type RateLimitHandler } from '../rate-limit.js'
import { userResponse } from '../user-response.js'
import type { RegistrationCodeStore } from './codes.js'

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

function failure(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof RateLimitError) {
    reply.code(error.statusCode).send({ detail: error.message })
    return true
  }
  if (!(error instanceof RegistrationRequestError)) return false
  reply.code(error.statusCode).send({ detail: error.message })
  return true
}

function reportRegistrationFailure(stage: string, error: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  const sqlState = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` SQLSTATE=${code}` : ''
  console.error(`gugu-webui registration ${stage} failed${sqlState}`)
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
      reportRegistrationFailure('rate limit', error)
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

    try {
      if (await options.userExists(body.username, email))
        return reply.code(400).send({ detail: '用户名或邮箱已被注册' })
    } catch (error) {
      reportRegistrationFailure('user lookup', error)
      throw error
    }

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
      reportRegistrationFailure('user transaction', error)
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
      user: userResponse(user),
    })
  })
}

export interface RegistrationCodeRateLimit {
  readonly bucket: 'register-code'
  readonly limit: 5
  readonly windowSeconds: 3600
  readonly deviceLimit: 3
  readonly deviceWindowSeconds: 3600
  readonly failClosed: true
}

export interface RegistrationCodeRouteOptions {
  /** Host combines the administrator switch and `systemEmailAvailable` before registering. */
  readonly registrationVerificationEnabled: boolean
  readonly systemEmailAvailable: boolean
  readonly rateLimit: RateLimitHandler
  readonly emailIsOccupied: (normalizedEmail: string) => Promise<boolean>
  readonly codeStore?: Pick<RegistrationCodeStore, 'createCode' | 'reserve' | 'clear'>
  /** Optional real SMTP sender. A missing or failed sender must never report successful delivery. */
  readonly sendRegistrationVerification?: (email: string, code: string) => Promise<boolean>
}

interface RegistrationCodeBody {
  email: string
}

function parseBody(body: unknown): RegistrationCodeBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const email = (body as Record<string, unknown>).email
  if (typeof email !== 'string' || email.length < 3 || email.length > 300) return null
  return { email }
}

function rateLimitOptions(): RegistrationCodeRateLimit {
  return {
    bucket: 'register-code',
    limit: 5,
    windowSeconds: 3600,
    deviceLimit: 3,
    deviceWindowSeconds: 3600,
    failClosed: true,
  }
}

export function registerRegistrationCodeRoute(
  app: FastifyInstance,
  options: RegistrationCodeRouteOptions,
): void {
  app.post('/api/v1/auth/registration-code', async (request: FastifyRequest, reply) => {
    const body = parseBody(request.body)
    if (!body) return reply.code(422).send({ detail: '注册验证码请求字段无效' })
    const codeStore = options.codeStore
    const sendRegistrationVerification = options.sendRegistrationVerification

    try {
      await options.rateLimit(request, rateLimitOptions())
    } catch (error) {
      if (error instanceof RateLimitError && error.statusCode === 429)
        return reply.code(429).send({ detail: error.message })
      if (error instanceof RateLimitError && error.statusCode === 503)
        return reply.code(503).send({ detail: error.message })
      return reply.code(503).send({ detail: '注册服务暂不可用，请稍后重试' })
    }

    if (!options.registrationVerificationEnabled || !options.systemEmailAvailable)
      return reply.code(503).send({ detail: '邮箱验证码注册当前不可用' })
    if (!codeStore)
      return reply.code(503).send({ detail: '验证码服务暂不可用，请稍后重试' })
    if (!sendRegistrationVerification)
      return reply.code(503).send({ detail: '邮箱验证码注册当前不可用' })

    let email: string
    try {
      email = normalizeEmail(body.email)
    } catch (error) {
      if (error instanceof InvalidEmailError)
        return reply.code(400).send({ detail: error.message })
      throw error
    }

    if (await options.emailIsOccupied(email)) return { ok: true }

    let code: string
    try {
      code = codeStore.createCode()
      if (!await codeStore.reserve(email, code)) return { ok: true }
    } catch {
      return reply.code(503).send({ detail: '验证码服务暂不可用，请稍后重试' })
    }

    let sent = false
    try {
      sent = await sendRegistrationVerification(email, code)
    } catch {
      sent = false
    }
    if (!sent) {
      try {
        await codeStore.clear(email)
      } catch {
        // 清理失败不应把邮件发送失败误报为成功，也不应暴露 Redis 细节。
      }
      return reply.code(503).send({ detail: '验证码邮件发送失败，请稍后重试' })
    }
    return { ok: true }
  })
}

export function registerRegistrationRoutes(app: FastifyInstance, options: {
  registration?: RegisterUserRouteOptions
  registrationCode?: RegistrationCodeRouteOptions
}): void {
  if (options.registrationCode) registerRegistrationCodeRoute(app, options.registrationCode)
  else {
    app.post('/api/v1/auth/registration-code', async (_request, reply) =>
      reply.code(503).send({ detail: '邮箱验证码注册当前不可用' }),
    )
  }
  if (options.registration) registerUserRoute(app, options.registration)
  else {
    // 缺少注册依赖时保留公开入口，并明确返回服务不可用。
    app.post('/api/v1/auth/register', async (_request, reply) =>
      reply.code(503).send({ detail: '注册服务暂不可用，请稍后重试' }),
    )
  }
}
