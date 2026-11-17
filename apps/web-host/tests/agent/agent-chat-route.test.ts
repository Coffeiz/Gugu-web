import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import Fastify from 'fastify'
import { registerAgentChatRoutes, type AgentChatService } from '../../src/domains/agent-sessions/agent-chat-route.js'

test('聊天流保持前端事件顺序，异常不泄露原文，续看和取消按认证 owner 查询', async () => {
  const app = Fastify()
  const calls: unknown[] = []
  const service: AgentChatService = {
    async start(owner, body, origin) {
      calls.push([owner, body.message, origin])
      return (async function* () {
        yield { type: 'session_id', session_id: 7 }
        yield { type: 'delta', text: '你好' }
        throw new Error('secret-token')
      })()
    },
    async resume(owner, id) { calls.push([owner, id]); return null },
    async cancel(owner, id) { calls.push([owner, id]); return { ok: true, outcome: 'requested' } },
  }
  registerAgentChatRoutes(app, {
    requireUser: async (request, reply) => { if (!request.headers.authorization) return reply.code(401).send() },
    userIdFromRequest: () => 'owner-a', service,
  })
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/chat', payload: { message: 'hi' } })).statusCode, 401)
  const response = await app.inject({ method: 'POST', url: '/api/v1/agent/chat', headers: { authorization: 'test', 'x-client-id': 'client' }, payload: { message: 'hi' } })
  assert.match(response.headers['content-type']!, /^text\/event-stream/)
  const events = response.body.trim().split('\n\n').map(line => JSON.parse(line.slice(6)))
  assert.deepEqual(events.map(event => event.type), ['session_id', 'delta', 'error', 'done'])
  assert.doesNotMatch(response.body, /secret-token/)
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agent/sessions/8/stream', headers: { authorization: 'test' } })).statusCode, 404)
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/sessions/8/cancel', headers: { authorization: 'test' } })).json().outcome, 'requested')
  assert.deepEqual(calls, [['owner-a', 'hi', 'client'], ['owner-a', 8], ['owner-a', 8]])
  await app.close()
})

test('客户端断开聊天 SSE 会释放订阅，但不取消已入队的后台 Run', async () => {
  const app = Fastify()
  let subscriptionSignal: AbortSignal | undefined
  let runQueued = false
  let cancelCalled = false
  let closeSubscription!: () => void
  const subscriptionClosed = new Promise<void>(resolve => { closeSubscription = resolve })
  const service: AgentChatService = {
    async start(_owner, _body, _origin, signal) {
      subscriptionSignal = signal
      runQueued = true
      return (async function* () {
        try {
          yield { type: 'session_id', session_id: 7 }
          if (signal?.aborted) return
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
        } finally { closeSubscription() }
      })()
    },
    async resume() { return null },
    async cancel() { cancelCalled = true; return { ok: true } },
  }
  registerAgentChatRoutes(app, {
    requireUser: async (request, reply) => { if (!request.headers.authorization) return reply.code(401).send() },
    userIdFromRequest: () => 'owner-a', service,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const port = (app.server.address() as AddressInfo).port
  try {
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/v1/agent/chat', method: 'POST',
        headers: { authorization: 'test', 'content-type': 'application/json' } }, response => {
        response.once('data', () => { req.destroy(); resolve() })
        response.once('error', reject)
      })
      req.once('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error) })
      req.end(JSON.stringify({ message: '合成消息' }))
    })
    await Promise.race([subscriptionClosed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE 订阅未及时释放')), 2_000))])
    assert.equal(subscriptionSignal?.aborted, true)
    assert.equal(runQueued, true)
    assert.equal(cancelCalled, false)
  } finally {
    await app.close()
  }
})
