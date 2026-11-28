export const MESSAGE_LEASE_SECONDS = 120
export const MESSAGE_LEASE_HEARTBEAT_SECONDS = 30
export const MESSAGE_COMPLETED_SECONDS = 3600

export const CLAIM_MESSAGE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == 'completed' then return 2 end
if current then return 0 end
local stored = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
if stored then return 1 end
return 0
`

export const RENEW_MESSAGE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`

export const COMPLETE_MESSAGE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('SET', KEYS[1], 'completed', 'EX', ARGV[2])
  return 1
end
if current == 'completed' then return 1 end
return 0
`

export interface RedisEvalClient {
  eval(script: string, keyCount: number, key: string, ...args: Array<string | number>): Promise<unknown>
}

export function messageStateKey(messageId: string): string {
  if (!messageId) throw new Error('消息 ID 不能为空')
  return `imstate:{${messageId}}`
}

/** 适配支持 EVAL(script, numKeys, ...args) 的 Redis 客户端。 */
export class RedisMessageLeaseStore {
  constructor(private readonly redis: RedisEvalClient) {}

  async claim(
    stateKey: string,
    owner: string,
    leaseSeconds = MESSAGE_LEASE_SECONDS,
  ): Promise<'claimed' | 'busy' | 'completed'> {
    const result = Number(
      await this.redis.eval(CLAIM_MESSAGE_SCRIPT, 1, stateKey, owner, leaseSeconds),
    )
    if (result === 2) return 'completed'
    return result === 1 ? 'claimed' : 'busy'
  }

  async renew(
    stateKey: string,
    owner: string,
    leaseSeconds = MESSAGE_LEASE_SECONDS,
  ): Promise<boolean> {
    return Number(
      await this.redis.eval(RENEW_MESSAGE_SCRIPT, 1, stateKey, owner, leaseSeconds),
    ) === 1
  }

  async complete(
    stateKey: string,
    owner: string,
    completedSeconds = MESSAGE_COMPLETED_SECONDS,
  ): Promise<boolean> {
    return Number(
      await this.redis.eval(COMPLETE_MESSAGE_SCRIPT, 1, stateKey, owner, completedSeconds),
    ) === 1
  }
}
