import type { ScheduledTaskLease } from '@gugu/scheduler'

export interface ScheduledTaskRedisCommands {
  set(key: string, value: string, ...options: string[]): Promise<unknown>
  eval(script: string, keyCount: number, ...args: string[]): Promise<unknown>
  exists(key: string): Promise<unknown>
}
const renewScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`
const releaseScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`

/** 与 Python worker 共用锁键和 token 语义。 */
export function createScheduledTaskRedisLease(redis: ScheduledTaskRedisCommands): ScheduledTaskLease {
  const key = (id: string) => `scheduled:lock:${id}`
  return {
    async acquire(id, owner, ms) { return await redis.set(key(id), owner, 'PX', String(ms), 'NX') === 'OK' },
    async renew(id, owner, ms) { return Number(await redis.eval(renewScript, 1, key(id), owner, String(ms))) === 1 },
    async release(id, owner) { await redis.eval(releaseScript, 1, key(id), owner) },
    async isHeld(id) { return Number(await redis.exists(key(id))) > 0 },
  }
}
