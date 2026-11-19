import type { FastifyInstance, FastifyRequest } from 'fastify'
import { InvalidEmailError, normalizeEmail } from '../email.js'
import type { RateLimitHandler } from '../rate-limit.js'
import { RateLimitError } from '../rate-limit.js'
import type { RegistrationCodeStore } from '../persistence/registration-codes.js'

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
