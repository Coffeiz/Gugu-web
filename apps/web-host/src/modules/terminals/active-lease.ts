import { randomUUID } from 'node:crypto'
import type { ScheduledTaskRedisCommands } from '../scheduled-tasks/persistence/redis-lease.js'

const renew = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end return 0`
const release = `if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0`
const cancel = `if redis.call('EXISTS',KEYS[1]) == 0 then return 0 end redis.call('SET',KEYS[2],'1','EX',ARGV[1]) return 1`

/** 活动租约使用随机 token，取消标记仅在租约存在时原子写入。 */
export function createTerminalActiveLease(redis: ScheduledTaskRedisCommands, leaseMs = 30000) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new RangeError('终端租约期限无效')
  const keys = (owner: string, terminal: string, request: string) => {
    if (![owner, terminal, request].every(value => value.length > 0 && value.length <= 128 && !/[\r\n]/.test(value))) throw new TypeError('终端租约身份无效')
    const suffix = [owner, terminal, request].map(encodeURIComponent).join(':')
    return [`terminal-active:v1:${suffix}`, `terminal-cancel:v1:${suffix}`] as const
  }
  return {
    async acquire(owner: string, terminal: string, request: string) {
      const token = randomUUID(), [active] = keys(owner, terminal, request)
      return await redis.set(active, token, 'PX', String(leaseMs), 'NX') === 'OK' ? token : null
    },
    async renew(owner: string, terminal: string, request: string, token: string) {
      return Number(await redis.eval(renew, 1, keys(owner, terminal, request)[0], token, String(leaseMs))) === 1
    },
    async release(owner: string, terminal: string, request: string, token: string) {
      return Number(await redis.eval(release, 1, keys(owner, terminal, request)[0], token)) === 1
    },
    async cancel(owner: string, terminal: string, request: string) {
      const [active, marker] = keys(owner, terminal, request)
      return Number(await redis.eval(cancel, 2, active, marker, '600')) === 1
    },
  }
}
