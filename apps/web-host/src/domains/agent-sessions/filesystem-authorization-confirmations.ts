import { createHash, randomBytes } from 'node:crypto'
import type { FilesystemAuthorizationConfirmationPort } from './agent-filesystem-authorization.js'

const REQUEST_PREFIX = 'agent:confirm-req'
const CODE_PREFIX = 'agent:confirm-code'
const GRANT_PREFIX = 'agent:confirm-grant'

export interface FilesystemAuthorizationRedisCommands {
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<number>
  eval(script: string, keyCount: number, ...args: string[]): Promise<string | null>
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function requestKey(ownerId: string, summary: string, identity: string): string {
  return `${REQUEST_PREFIX}:${ownerId}:${digest(summary)}:${digest(identity)}`
}

function grantKey(ownerId: string, summary: string, identity: string): string {
  return `${GRANT_PREFIX}:${ownerId}:${digest(summary)}:${digest(identity)}`
}

const createPendingScript = `
local current = redis.call('GET', KEYS[1])
if current then return current end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return ARGV[1]
`

const redeemScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or type(record.s) ~= 'string' or record.s == '' then
  return ''
end
local ttl = tonumber(record.ttl_minutes) or 5
if ttl < 1 or ttl ~= math.floor(ttl) then return '' end
local identity = type(record.i) == 'string' and record.i or ''
local key = 'agent:confirm-grant:' .. ARGV[1] .. ':' .. record.s .. ':' .. identity
redis.call('SET', key, '1', 'EX', tostring(math.floor(ttl * 60)))
redis.call('DEL', KEYS[1])
return '1'
`

/** 复用 Python 确认码键格式，使 Node 签发的确认码可由任一服务兑换。 */
export function createFilesystemAuthorizationConfirmationStore(
  redis: FilesystemAuthorizationRedisCommands,
  createCode: () => string = () => randomBytes(6).toString('hex'),
): FilesystemAuthorizationConfirmationPort {
  return {
    async revoke(ownerId, summary, identity) {
      try {
        const req = requestKey(ownerId, summary, identity)
        const code = await redis.get(req)
        const keys = [grantKey(ownerId, summary, identity), req]
        if (code) keys.push(`${CODE_PREFIX}:${ownerId}:${code}`)
        await redis.del(...keys)
        return true
      } catch {
        return false
      }
    },

    async createPending(ownerId, summary, identity, ttlMinutes) {
      if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1)
        throw new RangeError('Filesystem authorization confirmation TTL invalid')
      const code = createCode()
      if (!/^[a-f0-9]{12}$/i.test(code))
        throw new TypeError('Filesystem authorization confirmation code invalid')
      const summaryHash = digest(summary)
      const identityHash = digest(identity)
      const request = requestKey(ownerId, summary, identity)
      const codeKey = `${CODE_PREFIX}:${ownerId}:${code}`
      const record = JSON.stringify({ s: summaryHash, i: identityHash, ttl_minutes: ttlMinutes })
      try {
        const result = await redis.eval(
          createPendingScript,
          2,
          request,
          codeKey,
          code,
          record,
          String(ttlMinutes * 60),
        )
        return result && /^[a-f0-9]{12}$/i.test(result) ? result : null
      } catch {
        return null
      }
    },

    async redeem(ownerId, code) {
      if (!code.trim()) return false
      try {
        const result = await redis.eval(
          redeemScript,
          1,
          `${CODE_PREFIX}:${ownerId}:${code}`,
          ownerId,
        )
        return result === '1'
      } catch {
        return false
      }
    },

    async hasGrant(ownerId, summary, identity) {
      try {
        return (await redis.get(grantKey(ownerId, summary, identity))) === '1'
      } catch {
        return false
      }
    },
  }
}
