import type { RedisCommandClient } from '../../../../src/workers/redis-stream-queue.js'

/** 只模拟引用/FIFO脚本的可观察状态；Lua原子性、TYPE和真实TTL由opt-in Redis验证。 */
export function qqRedisDouble() {
  let now = 1_800_000_000_000
  const values = new Map<string, { data: string; expires: number }>(), indexes = new Map<string, Map<string, number>>()
  const lists = new Map<string, Array<{ expires: number; data: string }>>()
  const calls: string[][] = []
  const get = (key: string) => { const value = values.get(key); if (!value || value.expires <= now) { values.delete(key); return null }; return value.data }
  const redis: RedisCommandClient = { async sendCommand(parts) {
    calls.push(parts)
    if (parts[0] === 'GET') return get(parts[1]!)
    if (parts[0] !== 'EVAL' || parts[2] !== '2') throw new Error('Redis替身仅支持QQ引用协议')
    const [first, second] = parts.slice(3, 5) as [string, string], args = parts.slice(5)
    if (args.length === 6) {
      const members = indexes.get(second) ?? new Map<string, number>()
      for (const [key, score] of members) if (score <= Number(args[3])) members.delete(key)
      if (!members.has(first) && members.size >= Number(args[2])) {
        const oldest = [...members].sort((a, b) => a[1] - b[1])[0]![0]
        if (!oldest.startsWith(args[4]!)) throw new Error('QQ引用scope错误')
        members.delete(oldest); values.delete(oldest)
      }
      values.set(first, { data: args[0]!, expires: now + Number(args[1]) * 1000 })
      members.set(first, Number(args[5])); indexes.set(second, members); return 1
    }
    if (args.length === 2) {
      if (get(second)) return 1
      const queue = lists.get(first) ?? []
      if (queue.length >= Number(args[1])) throw new Error('QQ表情队列已满')
      queue.push(JSON.parse(args[0]!)); lists.set(first, queue)
      values.set(second, { data: '1', expires: now + 600_000 }); return 1
    }
    if (args.length === 1) {
      const cached = get(second)
      if (cached) return cached
      const queue = lists.get(first) ?? []
      while (queue.length && queue[0]!.expires <= Number(args[0])) queue.shift()
      const selected = queue.shift()?.data ?? '-'
      values.set(second, { data: selected, expires: now + 600_000 }); return selected
    }
    throw new Error('Redis替身不支持该QQ脚本参数')
  } }
  return { redis, calls, now: () => now, advance: (ms: number) => { now += ms }, values, indexes, lists }
}
