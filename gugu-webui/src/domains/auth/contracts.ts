import type { PublicUserRecord } from './auth.js'
import type { RateLimitHandler } from './rate-limit.js'

export interface UserAuthOptions {
  secret: string
  lookupUser: (userId: string) => Promise<PublicUserRecord | null>
  markUserActive?: (userId: string) => Promise<void>
  authenticateCredentials?: (username: string, password: string) => Promise<PublicUserRecord | null>
  recordLogin?: (userId: string) => Promise<void>
  rateLimit?: RateLimitHandler
  revokeUserSessions?: (userId: string) => Promise<void>
  publishAuthStateChanged?: (userId: string) => Promise<unknown>
}
