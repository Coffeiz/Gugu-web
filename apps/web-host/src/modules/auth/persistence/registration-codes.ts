import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { RegistrationCodeTransactionPort } from './registration.js'

export const REGISTRATION_CODE_TTL_SECONDS = 10 * 60
export const REGISTRATION_CODE_COOLDOWN_SECONDS = 60
export const REGISTRATION_CODE_MAX_ATTEMPTS = 5

export interface RegistrationCodeRedisCommands {
  set(key: string, value: string, ...options: string[]): Promise<string | null>
  get(key: string): Promise<string | null>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  del(...keys: string[]): Promise<number>
  pttl(key: string): Promise<number>
  eval(script: string, keyCount: number, ...args: string[]): Promise<number>
}

export interface RegistrationCodeStore extends RegistrationCodeTransactionPort {
  createCode(): string
  reserve(email: string, code: string): Promise<boolean>
  verify(email: string, code: string): Promise<boolean>
  clear(email: string): Promise<void>
}

const consumeCodeScript = `
local current = redis.call('GET', KEYS[1])
if not current or current ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`

function emailKey(email: string): string {
  return createHash('sha256').update(email, 'utf8').digest('hex')
}

function codeDigest(secret: string, email: string, code: string): string {
  return createHmac('sha256', secret).update(`${email}\0${code}`, 'utf8').digest('hex')
}

function safeEqual(left: string | null, right: string): boolean {
  if (!left) return false
  const leftBytes = Buffer.from(left, 'ascii')
  const rightBytes = Buffer.from(right, 'ascii')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

/** Redis-backed registration verification state matching Python TTLs and attempt limits. */
export function createRedisRegistrationCodeStore(
  redis: RegistrationCodeRedisCommands,
  secret: string,
  generateCode: () => string = () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
): RegistrationCodeStore {
  if (!secret) throw new Error('Registration code signing secret is required')

  const keys = (email: string) => {
    const digest = emailKey(email)
    return {
      code: `regverify:code:${digest}`,
      cooldown: `regverify:cooldown:${digest}`,
      attempts: `regverify:attempts:${digest}`,
    }
  }

  return {
    createCode() {
      const code = generateCode()
      if (!/^\d{6}$/.test(code)) throw new Error('Registration code generator returned an invalid code')
      return code
    },

    async reserve(email, code) {
      if (!/^\d{6}$/.test(code)) throw new Error('Registration code must contain six digits')
      const key = keys(email)
      const reserved = await redis.set(
        key.cooldown, '1', 'EX', String(REGISTRATION_CODE_COOLDOWN_SECONDS), 'NX',
      )
      if (reserved !== 'OK') return false
      try {
        await redis.set(
          key.code,
          codeDigest(secret, email, code),
          'EX', String(REGISTRATION_CODE_TTL_SECONDS),
        )
        await redis.del(key.attempts)
      } catch (error) {
        await redis.del(key.cooldown)
        throw error
      }
      return true
    },

    async verify(email, code) {
      const key = keys(email)
      const attempts = await redis.incr(key.attempts)
      if (attempts === 1) await redis.expire(key.attempts, REGISTRATION_CODE_TTL_SECONDS)
      if (attempts > REGISTRATION_CODE_MAX_ATTEMPTS) return false
      const stored = await redis.get(key.code)
      return safeEqual(stored, codeDigest(secret, email, code))
    },

    async clear(email) {
      const key = keys(email)
      await redis.del(key.code, key.cooldown, key.attempts)
    },

    async remainingTtlMs(email) {
      const ttl = await redis.pttl(keys(email).code)
      return ttl > 0 ? ttl : 0
    },

    async consume(email, code) {
      const key = keys(email).code
      const result = await redis.eval(
        consumeCodeScript, 1, key, codeDigest(secret, email, code),
      )
      return result === 1
    },

    async restore(email, code, remainingTtlMs) {
      if (!Number.isFinite(remainingTtlMs) || remainingTtlMs <= 0) return
      await redis.set(
        keys(email).code,
        codeDigest(secret, email, code),
        'PX', String(Math.trunc(remainingTtlMs)),
        'NX',
      )
    },
  }
}
