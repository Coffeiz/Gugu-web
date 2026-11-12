import type { InboundMessage, StreamQueue } from './consumer.js'

export interface RedisCommandClient {
  sendCommand(args: string[]): Promise<unknown>
}

/** 使用 Redis Streams 命令读、重领并确认入站消息。 */
export class RedisStreamQueue implements StreamQueue {
  constructor(
    private readonly redis: RedisCommandClient,
    private readonly stream: string,
    private readonly group: string,
    private readonly consumer: string,
  ) {}

  async claimStale(count: number, minIdleMs: number): Promise<InboundMessage[]> {
    const result = await this.redis.sendCommand([
      'XAUTOCLAIM', this.stream, this.group, this.consumer,
      String(minIdleMs), '0-0', 'COUNT', String(count),
    ])
    if (!Array.isArray(result) || !Array.isArray(result[1])) return []
    return (result[1] as unknown[]).map(parseEntry)
  }

  async consume(count: number, blockMs: number): Promise<InboundMessage[]> {
    if (count <= 0) return []
    const command = [
      'XREADGROUP', 'GROUP', this.group, this.consumer,
      'COUNT', String(count),
    ]
    if (blockMs > 0) command.push('BLOCK', String(blockMs))
    command.push('STREAMS', this.stream, '>')
    const result = await this.redis.sendCommand(command)
    if (!Array.isArray(result) || !Array.isArray(result[0])) return []
    const [, entries] = result[0] as [unknown, unknown]
    return Array.isArray(entries) ? entries.map(parseEntry) : []
  }

  async acknowledge(messageId: string): Promise<void> {
    await this.redis.sendCommand(['XACK', this.stream, this.group, messageId])
  }
}

function parseEntry(value: unknown): InboundMessage {
  if (!Array.isArray(value) || typeof value[0] !== 'string' || !Array.isArray(value[1]))
    throw new Error('Redis Stream 消息格式无效')
  const fields = value[1] as unknown[]
  const payloadIndex = fields.findIndex(field => field === 'data')
  if (payloadIndex < 0 || typeof fields[payloadIndex + 1] !== 'string')
    throw new Error('Redis Stream 消息缺少 data')
  const payload = JSON.parse(fields[payloadIndex + 1] as string)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Redis Stream payload 必须是对象')
  return { id: value[0], payload: payload as Record<string, unknown> }
}
