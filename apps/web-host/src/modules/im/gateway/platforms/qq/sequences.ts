import { createHash } from 'node:crypto'
import type { RedisCommandClient } from '../../../../../workers/redis-stream-queue.js'

const increment = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return value
`

/** 文本/媒体/stream共用同一Bot的持久序号；Redis失败不得退化为本地计数。 */
export function createQqReplySequences(redis: RedisCommandClient, binding: { ownerId: string; botId: string }) {
  if (!binding.ownerId || !/^[1-9]\d*$/.test(binding.botId)) throw new TypeError('QQ 序号归属无效')
  const { ownerId, botId } = binding
  async function next(targetBot: string, purpose: 'reply' | 'stream', messageId: string, seconds: number): Promise<number> {
    if (targetBot !== botId || (purpose === 'reply' && !messageId)) throw new TypeError('QQ 序号作用域不匹配')
    const key = 'im:node:qq:sequence:' + createHash('sha256').update(JSON.stringify([ownerId, botId, purpose, messageId])).digest('hex')
    try {
      const result = await redis.sendCommand(['EVAL', increment, '1', key, String(seconds)])
      const value = typeof result === 'number' || typeof result === 'string' && /^[1-9]\d*$/.test(result) ? Number(result) : NaN
      if (!Number.isSafeInteger(value) || value < 1) throw new Error()
      return value
    } catch { throw new Error('QQ 持久回复序号不可用') }
  }
  return {
    nextPassive(input: { botId: string; messageId: string; ttlSeconds: 4200 }) {
      if (input.ttlSeconds !== 4200) return Promise.reject(new TypeError('QQ 被动回复窗口无效'))
      return next(input.botId, 'reply', input.messageId, 4200)
    },
    nextStream(input: { botId: string; ttlSeconds: 600 }) {
      if (input.ttlSeconds !== 600) return Promise.reject(new TypeError('QQ 主动流式窗口无效'))
      return next(input.botId, 'stream', '', 600)
    },
  }
}
