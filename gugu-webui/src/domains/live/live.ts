import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import {
  RedisLiveSubscriptionError,
  type LiveSubscriptionFactory,
} from '../../adapters/redis-live-subscription.js'

export const LIVE_BROADCAST_CHANNEL = 'events:__broadcast__'

const liveResources = new Set([
  'projects', 'calendar', 'files', 'mind', 'scheduled_tasks', 'sessions',
  'clients', 'im_channels', 'terminals', 'pending_queues', 'skills',
])
const liveOperations = new Set(['create', 'update', 'delete', 'move', 'append', 'refresh'])
const resetFrame = ': live connection reset; client will reconnect\n\n'
const connectedFrame = ': connected\n\n'
const suspendedFrame = 'event: account_suspended\ndata: {"message":"账号暂时不可用"}\n\n'

export interface LiveStreamOperations {
  subscribe: LiveSubscriptionFactory
  isUserActive(ownerId: string, expectedSecurityVersion: number): Promise<boolean>
}

export interface LiveRouteOptions {
  requireUser: preHandlerHookHandler
  ownerIdFromRequest(request: FastifyRequest): string
  securityVersionFromRequest(request: FastifyRequest): number
  operations: LiveStreamOperations
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isLiveEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.protocol_version === 'live-event-v1'
    && typeof value.event_id === 'string' && value.event_id.length > 0
    && value.type === 'resource.changed'
    && typeof value.resource === 'string' && liveResources.has(value.resource)
    && typeof value.operation === 'string' && liveOperations.has(value.operation)
    && isInteger(value.revision)
    && typeof value.created_at === 'string'
}

function isTrashPurgeProgressEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.protocol_version === 'live-event-v1'
    && typeof value.event_id === 'string' && value.event_id.length > 0
    && value.type === 'task.progress'
    && value.task_type === 'trash_purge'
    && isInteger(value.task_id) && value.task_id > 0
    && typeof value.status === 'string'
    && ['queued', 'running', 'completed', 'failed'].includes(value.status)
    && isInteger(value.progress_current) && value.progress_current >= 0
    && isInteger(value.progress_total) && value.progress_total >= 0
    && isInteger(value.failed_count) && value.failed_count >= 0
    && typeof value.created_at === 'string'
}

function isAgentRunChangedEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.protocol_version === 'live-event-v1'
    && typeof value.event_id === 'string' && value.event_id.length > 0
    && value.type === 'agent.run.changed'
    && isInteger(value.session_id) && value.session_id > 0
    && ['running', 'completed', 'failed'].includes(String(value.status))
    && typeof value.created_at === 'string'
}

function sanitizeAgentRunChangedEvent(value: Record<string, unknown>): Record<string, unknown> {
  const fields = ['protocol_version', 'event_id', 'type', 'session_id', 'status', 'created_at']
  return Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]))
}

function isFilesyncEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)
    || value.protocol_version !== 'live-event-v1'
    || typeof value.event_id !== 'string' || !value.event_id
    || !isInteger(value.binding_id) || value.binding_id <= 0
    || !isInteger(value.revision) || value.revision < 0
    || typeof value.created_at !== 'string'
    || !Number.isFinite(Date.parse(value.created_at))) return false
  if (value.type === 'filesync.run.changed')
    return typeof value.run_id === 'string' && value.run_id.length > 0
  return value.type === 'filesync.binding.health.changed'
}

function sanitizeFilesyncEvent(value: Record<string, unknown>): Record<string, unknown> {
  const fields = ['protocol_version', 'event_id', 'type', 'binding_id', 'revision', 'created_at']
  if (value.type === 'filesync.run.changed') fields.push('run_id')
  return Object.fromEntries(fields.filter((key) => key in value).map((key) => [key, value[key]]))
}

/** 接受与 Python live stream 相同的业务 envelope，并裁剪 filesync/agent 事件字段。 */
export function serializeLiveMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return null
  }

  if (isFilesyncEvent(value)) value = sanitizeFilesyncEvent(value)
  else if (isAgentRunChangedEvent(value)) value = sanitizeAgentRunChangedEvent(value)
  else if (!(isLiveEvent(value) || isTrashPurgeProgressEvent(value)
    || (isRecord(value) && isRecord(value.notification))
    || (isRecord(value) && isRecord(value.present)
      && isInteger(value.present.file_id)))) return null

  return `data: ${JSON.stringify(value)}\n\n`
}

async function* streamEvents(
  ownerId: string,
  expectedSecurityVersion: number,
  options: LiveRouteOptions,
  abort: AbortController,
): AsyncGenerator<string> {
  let subscription: Awaited<ReturnType<LiveSubscriptionFactory>> | null = null
  const channels = [`events:${ownerId}`, LIVE_BROADCAST_CHANNEL] as const
  try {
    subscription = await options.operations.subscribe(channels)
    yield connectedFrame
    if (!await options.operations.isUserActive(ownerId, expectedSecurityVersion)) {
      yield suspendedFrame
      return
    }
    while (!abort.signal.aborted) {
      const message = await subscription.next(abort.signal)
      if (message === null) return
      if (!await options.operations.isUserActive(ownerId, expectedSecurityVersion)) {
        yield suspendedFrame
        return
      }
      // auth.state.changed 是唤醒控制消息，不向浏览器公开。
      const frame = serializeLiveMessage(message.data)
      if (frame) yield frame
    }
  } catch (error) {
    if (abort.signal.aborted) return
    if (error instanceof RedisLiveSubscriptionError) {
      yield resetFrame
      return
    }
    throw error
  } finally {
    try {
      await subscription?.close()
    } catch {
      // 断开客户端时释放订阅是 best-effort，不输出 Redis 错误正文。
    }
  }
}

export function registerLiveRoutes(app: FastifyInstance, options: LiveRouteOptions): void {
  app.get('/api/v1/live/stream', { preHandler: options.requireUser }, async (request, reply) => {
    const ownerId = options.ownerIdFromRequest(request)
    const expectedSecurityVersion = options.securityVersionFromRequest(request)
    const abort = new AbortController()
    const abortStream = () => abort.abort()
    reply.raw.once('close', abortStream)
    const stream = Readable.from(streamEvents(ownerId, expectedSecurityVersion, options, abort))
    stream.once('close', () => reply.raw.off('close', abortStream))
    return reply
      .type('text/event-stream; charset=utf-8')
      .header('Cache-Control', 'no-cache, no-transform')
      .header('Connection', 'keep-alive')
      .header('X-Accel-Buffering', 'no')
      .send(stream)
  })
}
