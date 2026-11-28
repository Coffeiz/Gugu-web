import type { RedisAgentCancellationCommands } from '../../../adapters/cache/redis-events.js'

/** 取消标记仅包含 owner、终端和请求标识，不包含命令或输出。 */
export function createTerminalCancellationMarkers(redis: RedisAgentCancellationCommands, ttlSeconds = 600) {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new RangeError('终端取消期限无效')
  const key = (owner: string, terminal: string, request: string) => {
    if (![owner, terminal, request].every(value => value.length > 0 && value.length <= 128 && !/[\r\n]/.test(value))) throw new TypeError('终端取消身份无效')
    return `terminal-cancel:v1:${encodeURIComponent(owner)}:${encodeURIComponent(terminal)}:${encodeURIComponent(request)}`
  }
  return {
    async request(owner: string, terminal: string, request: string) {
      const marker = key(owner, terminal, request)
      if (!await redis.set(marker, '1', ttlSeconds)) throw new Error('终端取消标记写入失败')
    },
    async isRequested(owner: string, terminal: string, request: string) {
      return await redis.get(key(owner, terminal, request)) === '1'
    },
  }
}
