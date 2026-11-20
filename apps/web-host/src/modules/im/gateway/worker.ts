import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { WorkerConsumer } from '../../../workers/consumer.js'
import { RedisStreamQueue } from '../../../workers/redis-stream-queue.js'
import { RedisMessageLeaseStore } from '../../../workers/redis-message-lease.js'
import { createRedisStreamCommands, RedisStreamCommandError } from '../../../adapters/cache/redis-stream-commands.js'
import { createImInboundEnvelope } from './inbound/envelope.js'
import { NODE_IM_INBOUND_STREAM, type NodeImBotBinding } from './inbound/inbox.js'
import type { createPostgresImIngress } from './inbound/ingress.js'

type Commands = ReturnType<typeof createRedisStreamCommands>
const group = 'gugu-node-im-v1'
function bindingOf(payload: Record<string, unknown>): NodeImBotBinding {
  if (!['feishu', 'qq', 'wechat', 'telegram'].includes(String(payload.platform))
    || typeof payload.bot_id !== 'string' || !/^[1-9]\d*$/.test(payload.bot_id)
    || typeof payload.owner_user_id !== 'string' || !payload.owner_user_id) throw new Error('Node IM 入站路由无效')
  return { ownerId: payload.owner_user_id, botId: payload.bot_id, platform: payload.platform as NodeImBotBinding['platform'] }
}

/** 独立Node Stream消费者；只在IM消息/调度事务提交后ACK，不消费Python队列。 */
export function createNodeImWorker(options: {
  secretKey: string
  commands: Commands
  ingress: Pick<ReturnType<typeof createPostgresImIngress>, 'handle'> & Partial<Pick<ReturnType<typeof createPostgresImIngress>, 'prepare' | 'handleBatch'>> & {
    prepareAdmitted?: ReturnType<typeof createPostgresImIngress>['prepare']
  }
  concurrency: number
  batchDelayMs?: number
  /** 部署必须显式停止旧消费者；不同consumer group本身不能防双回复。 */
  ownership: { runtime: 'node'; pythonGatewayStopped: boolean; pythonImConsumerStopped: boolean }
  diagnose(code: 'queue_unavailable' | 'message_failed', error?: unknown): void
}) {
  const envelope = createImInboundEnvelope(options.secretKey)
  const controller = new AbortController()
  const batched = typeof options.ingress.prepare === 'function' && typeof options.ingress.prepareAdmitted === 'function' && typeof options.ingress.handleBatch === 'function'
  if ((options.ingress.prepare !== undefined || options.ingress.prepareAdmitted !== undefined || options.ingress.handleBatch !== undefined) && !batched)
    throw new TypeError('Node IM 批次准备和处理端口必须同时配置')
  const consumerName = randomUUID()
  const consumer = new WorkerConsumer({ queue: new RedisStreamQueue(options.commands, NODE_IM_INBOUND_STREAM, group, consumerName,
    id => ({ id, payload: { __invalid_stream_payload: true } })),
    leases: new RedisMessageLeaseStore(options.commands), concurrency: options.concurrency, createOwner: randomUUID,
    onFailure: error => options.diagnose('message_failed', error),
    stateKey: id => `im:node:state:${id}`,
    conversationKey(message) {
      try {
        const b = bindingOf(message.payload), p = message.payload
        return JSON.stringify([b.ownerId, b.platform, b.botId, p.chat_type, p.chat_type === 'group' ? p.chat_id : p.platform_user_id])
      } catch { return JSON.stringify(['invalid', message.id]) }
    },
    async handle(eventId, sealed) {
      const binding = bindingOf(sealed)
      const opened = envelope.openForWorker(binding, sealed)
      if (opened.admission === 'gateway') throw new Error('Node IM 可信准入处理端口未配置')
      await options.ingress.handle(binding, opened.payload, eventId, controller.signal)
    },
    ...(batched ? {
      batchDelayMs: options.batchDelayMs,
      async beforeBatch(eventId: string, sealed: Record<string, unknown>) {
        const binding = bindingOf(sealed), opened = envelope.openForWorker(binding, sealed), payload = opened.payload
        controller.signal.throwIfAborted()
        // 正式队列只接受Gateway完成控制分流的证明；旧im1不能重新解释为新stage的凭据/选项。
        if (opened.admission !== 'gateway') throw new Error('Node IM 入站准入证明缺失')
        return await options.ingress.prepareAdmitted!(binding, payload, eventId, controller.signal) ? payload : null
      },
      async handleBatch(messages: readonly { id: string; payload: Record<string, unknown> }[]) {
        controller.signal.throwIfAborted()
        if (!messages.length) throw new Error('Node IM 消息段为空')
        const binding = bindingOf(messages[0]!.payload)
        if (messages.some(message => {
          const current = bindingOf(message.payload)
          return current.ownerId !== binding.ownerId || current.platform !== binding.platform || current.botId !== binding.botId
        })) throw new Error('Node IM 消息段归属不匹配')
        await options.ingress.handleBatch!(binding, messages.map(message => ({ eventId: message.id, payload: message.payload })), controller.signal)
      },
    } : {}),
  })
  let loop: Promise<void> | null = null, stopping: Promise<void> | null = null
  let status: 'stopped' | 'starting' | 'running' | 'degraded' = 'stopped'
  return {
    health() { return { status, messageFailures: consumer.failures } },
    async start() {
      if (loop || status !== 'stopped' || controller.signal.aborted) throw new Error('Node IM 消费者已经启动或停止')
      if (options.ownership.runtime !== 'node' || options.ownership.pythonGatewayStopped !== true || options.ownership.pythonImConsumerStopped !== true)
        throw new Error('Node IM 消费归属尚未切换')
      status = 'starting'
      try { await options.commands.sendCommand(['XGROUP', 'CREATE', NODE_IM_INBOUND_STREAM, group, '0', 'MKSTREAM'], controller.signal) }
      catch (error) {
        if (!(error instanceof RedisStreamCommandError) || error.code !== 'busy_group') { status = 'stopped'; throw new Error('Node IM 消费组创建失败') }
      }
      status = 'running'
      loop = (async () => {
        let backoff = 1000
        try {
          while (!controller.signal.aborted) {
            try {
              await consumer.waitForCapacity()
              if (controller.signal.aborted) return
              await consumer.runOnce(1000)
              status = 'running'; backoff = 1000
            } catch (error) {
              if (controller.signal.aborted) return
              status = 'degraded'; options.diagnose('queue_unavailable', error)
              await delay(backoff, undefined, { signal: controller.signal })
              backoff = Math.min(60000, backoff * 2)
            }
          }
        } catch { if (!controller.signal.aborted) throw new Error('Node IM 消费循环退出') }
        finally { status = 'stopped' }
      })()
      void loop.catch(() => { status = 'stopped' })
    },
    stop(): Promise<void> {
      return stopping ??= (async () => {
        controller.abort()
        // 中断阻塞读后排空在途事务；不删队列、租约或其他运行时状态。
        const draining = consumer.close()
        try { await options.commands.close(); await loop } finally { await draining; status = 'stopped' }
      })()
    },
  }
}
