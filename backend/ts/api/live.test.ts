import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'

import { authorizeRequest, liveChannelFor, serializeLiveEvent } from './live.ts'

function token(secret: string, payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const head = encode({ alg: 'HS256', typ: 'JWT' })
  const body = encode(payload)
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

test('live API 只接受有效的 user JWT 并按用户隔离频道', () => {
  const secret = 'test-secret'
  const request = (authorization: string) => ({ headers: { authorization } }) as any
  const jwt = token(secret, { sub: 'user-a', role: 'user', exp: Math.floor(Date.now() / 1000) + 60 })
  assert.equal(authorizeRequest(request(`Bearer ${jwt}`), secret), 'user-a')
  assert.equal(authorizeRequest(request(`Bearer ${jwt}`), 'wrong-secret'), null)
  assert.equal(authorizeRequest(request(`Bearer ${token(secret, { sub: 'user-a', role: 'admin', exp: 9999999999 })}`), secret), null)
  assert.equal(liveChannelFor('user-a'), 'events:user-a')
  assert.notEqual(liveChannelFor('user-a'), liveChannelFor('user-b'))
})

test('live API 拒绝过期、错误签名和非 user token', () => {
  const secret = 'test-secret'
  const request = (authorization: string) => ({ headers: { authorization } }) as any
  assert.equal(authorizeRequest(request('Bearer malformed'), secret), null)
  assert.equal(authorizeRequest(request(`Bearer ${token(secret, { sub: 'user-a', role: 'user', exp: Math.floor(Date.now() / 1000) - 1 })}`), secret), null)
  assert.equal(authorizeRequest(request(`Bearer ${token(secret, { sub: 'user-a', role: 'admin', exp: Math.floor(Date.now() / 1000) + 60 })}`), secret), null)
})

test('live API 只转发 canonical 业务事件和广播通知', () => {
  const event = {
    protocol_version: 'live-event-v1', event_id: 'evt-1', type: 'resource.changed',
    resource: 'mind', operation: 'update', revision: 3,
    created_at: '2026-08-26T12:00:00.000Z', payload: { kind: 'note' },
  }
  assert.equal(serializeLiveEvent(JSON.stringify(event)), `data: ${JSON.stringify(event)}\n\n`)
  assert.equal(serializeLiveEvent(JSON.stringify({ notification: { title: '更新' } })), `data: {"notification":{"title":"更新"}}\n\n`)
  assert.equal(serializeLiveEvent(JSON.stringify({ resources: ['mind'] })), null)
  assert.equal(serializeLiveEvent('{bad json'), null)
})
