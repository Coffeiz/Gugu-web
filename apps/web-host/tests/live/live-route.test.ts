import assert from 'node:assert/strict'
import { once } from 'node:events'
import { get as httpGet, type ClientRequest } from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import test from 'node:test'
import {
  RedisLiveSubscriptionError,
  type LiveSubscription,
} from '../../src/adapters/redis-live-subscription.js'
import { LIVE_BROADCAST_CHANNEL, registerLiveRoutes, type LiveStreamOperations } from '../../src/domains/live/live.js'

const ownerId = 'f45a2d6c-8f42-48c2-a07a-91edb07c9383'
const securityVersion = 7

interface TestSubscription extends LiveSubscription {
  readonly closed: boolean
}

function makeSubscription(messages: string[] = []): TestSubscription {
  let closed = false
  return {
    get closed() { return closed },
    async next() {
      const data = messages.shift()
      return data === undefined ? null : { channel: `events:${ownerId}`, data }
    },
    async close() { closed = true },
  }
}

function makeApp(
  subscription: LiveSubscription,
  options: Partial<LiveStreamOperations> = {},
): { app: FastifyInstance; calls: Array<{ kind: string; value: unknown }> } {
  const calls: Array<{ kind: string; value: unknown }> = []
  const operations: LiveStreamOperations = {
    subscribe: async (channels) => {
      calls.push({ kind: 'channels', value: channels })
      return subscription
    },
    isUserActive: async (user, version) => {
      calls.push({ kind: 'active', value: [user, version] })
      return true
    },
    ...options,
  }
  const app = Fastify()
  registerLiveRoutes(app, {
    requireUser: async () => {},
    ownerIdFromRequest: () => ownerId,
    securityVersionFromRequest: () => securityVersion,
    operations,
  })
  return { app, calls }
}

function liveEvent(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: 'live-event-v1',
    event_id: 'evt-synthetic-1',
    type: 'resource.changed',
    resource: 'files',
    operation: 'update',
    revision: 3,
    created_at: '2026-11-14T00:00:00+00:00',
    ...overrides,
  }
}

test('实时流使用认证 owner 频道，先发首帧并返回 canonical 事件与 SSE headers', async () => {
  const subscription = makeSubscription([JSON.stringify(liveEvent())])
  const { app, calls } = makeApp(subscription)
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/stream' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8')
    assert.equal(response.headers['cache-control'], 'no-cache, no-transform')
    assert.equal(response.headers.connection, 'keep-alive')
    assert.equal(response.headers['x-accel-buffering'], 'no')
    assert.match(response.body, /^: connected\n\ndata: /)
    assert.ok(response.body.includes(JSON.stringify(liveEvent())))
    assert.deepEqual(calls, [
      { kind: 'channels', value: [`events:${ownerId}`, LIVE_BROADCAST_CHANNEL] },
      { kind: 'active', value: [ownerId, securityVersion] },
      { kind: 'active', value: [ownerId, securityVersion] },
    ])
    assert.equal(subscription.closed, true)
  } finally {
    await app.close()
  }
})

test('实时流裁剪 agent/filesync 字段并过滤无效 envelope 与控制消息', async () => {
  const agent = {
    protocol_version: 'live-event-v1', event_id: 'agent-1', type: 'agent.run.changed',
    session_id: 12, status: 'running', created_at: '2026-11-14T00:00:00+00:00', secret: 'drop-me',
  }
  const filesync = {
    protocol_version: 'live-event-v1', event_id: 'sync-1', type: 'filesync.run.changed',
    binding_id: 5, run_id: 'run-5', revision: 4, created_at: '2026-11-14T00:00:00+00:00',
    payload: 'drop-me',
  }
  const invalid = JSON.stringify(liveEvent({ resource: 'unknown' }))
  const subscription = makeSubscription([
    invalid,
    JSON.stringify({ type: 'auth.state.changed' }),
    JSON.stringify(agent),
    JSON.stringify(filesync),
  ])
  const { app, calls } = makeApp(subscription)
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/stream' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body.includes(invalid), false)
    assert.equal(response.body.includes('auth.state.changed'), false)
    assert.ok(response.body.includes('"session_id":12'))
    assert.equal(response.body.includes('"secret"'), false)
    assert.ok(response.body.includes('"binding_id":5'))
    assert.equal(response.body.includes('"payload"'), false)
    assert.equal(calls.filter((call) => call.kind === 'active').length, 5)
    assert.equal(subscription.closed, true)
  } finally {
    await app.close()
  }
})

test('实时流接受提醒进度、通知和 present 文件消息，并拒绝畸形任务进度', async () => {
  const progress = {
    protocol_version: 'live-event-v1', event_id: 'purge-1', type: 'task.progress',
    task_type: 'trash_purge', task_id: 12, status: 'running', progress_current: 1,
    progress_total: 4, failed_count: 0, created_at: '2026-11-14T00:00:00+00:00',
  }
  const badProgress = { ...progress, task_id: true }
  const notification = { notification: { id: 2, title: '合成通知' } }
  const present = { present: { file_id: 9, name: '合成文件.png' } }
  const subscription = makeSubscription([progress, badProgress, notification, present]
    .map((value) => JSON.stringify(value)))
  const { app } = makeApp(subscription)
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/stream' })
    assert.equal(response.statusCode, 200)
    assert.ok(response.body.includes(JSON.stringify(progress)))
    assert.equal(response.body.includes(JSON.stringify(badProgress)), false)
    assert.ok(response.body.includes(JSON.stringify(notification)))
    assert.ok(response.body.includes(JSON.stringify(present)))
  } finally {
    await app.close()
  }
})

test('账号停用或 security version 变化时发送终止事件并关闭 Redis 订阅', async () => {
  const subscription = makeSubscription([JSON.stringify(liveEvent())])
  const { app, calls } = makeApp(subscription, {
    isUserActive: async (user, version) => {
      calls.push({ kind: 'active', value: [user, version] })
      return false
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/stream' })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /^: connected\n\nevent: account_suspended\ndata: /)
    assert.equal(response.body.includes('evt-synthetic-1'), false)
    assert.equal(subscription.closed, true)
    assert.deepEqual(calls, [
      { kind: 'channels', value: [`events:${ownerId}`, LIVE_BROADCAST_CHANNEL] },
      { kind: 'active', value: [ownerId, securityVersion] },
    ])
  } finally {
    await app.close()
  }
})

test('Redis 订阅断开时只发送 reset 提示，不泄露异常正文', async () => {
  const subscription: LiveSubscription = {
    async next() { throw new RedisLiveSubscriptionError() },
    async close() {},
  }
  const { app } = makeApp(subscription)
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/stream' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, ': connected\n\n: live connection reset; client will reconnect\n\n')
    assert.equal(response.body.includes('Redis live subscription unavailable'), false)
  } finally {
    await app.close()
  }
})

test('Redis 建连失败在首帧前发 reset 并返回流', async () => {
  const { app } = makeApp(makeSubscription(), {
    subscribe: async () => { throw new RedisLiveSubscriptionError() },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/stream' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.body, ': live connection reset; client will reconnect\n\n')
  } finally {
    await app.close()
  }
})

test('认证失败由 Host hook 拒绝且不会解析 owner 或建立 Redis 订阅', async () => {
  let subscribed = false
  let ownerRead = false
  const app = Fastify()
  registerLiveRoutes(app, {
    requireUser: async (_request, reply) => { reply.code(401).send({ detail: '认证失败' }) },
    ownerIdFromRequest: () => { ownerRead = true; return ownerId },
    securityVersionFromRequest: () => securityVersion,
    operations: {
      subscribe: async () => { subscribed = true; return makeSubscription() },
      isUserActive: async () => true,
    },
  })
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/live/stream' })
    assert.equal(response.statusCode, 401)
    assert.equal(ownerRead, false)
    assert.equal(subscribed, false)
  } finally {
    await app.close()
  }
})

test('客户端断开会 abort 阻塞的 next 并清理订阅', async () => {
  let closed = false
  let aborted = false
  let request: ClientRequest | undefined
  let closeSubscription!: () => void
  const subscriptionClosed = new Promise<void>((resolve) => { closeSubscription = resolve })
  const subscription: LiveSubscription = {
    next(signal) {
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          aborted = true
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    async close() { closed = true; closeSubscription() },
  }
  const { app } = makeApp(subscription)
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const responsePromise = new Promise<void>((resolve, reject) => {
      request = httpGet(`${address}/api/v1/live/stream`, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
          if (body.includes(': connected\n\n')) resolve()
        })
        response.on('error', reject)
      })
      request.on('error', (error) => {
        if (!request?.destroyed) reject(error)
      })
    })
    await responsePromise
    request!.destroy()
    await subscriptionClosed
    assert.equal(aborted, true)
    assert.equal(closed, true)
  } finally {
    request?.destroy()
    await app.close()
  }
})
