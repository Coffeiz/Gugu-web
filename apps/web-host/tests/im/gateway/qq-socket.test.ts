import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Agent } from 'node:https'
import { test } from 'node:test'
import WebSocket, { type ClientOptions } from 'ws'
import { createQqSocketFactory } from '../../../src/modules/im/gateway/qq/socket.js'

class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING
  sent: string[] = []
  stopped = false
  open() { this.readyState = WebSocket.OPEN; this.emit('open') }
  terminate() { this.stopped = true; this.readyState = WebSocket.CLOSED; this.emit('close') }
  send(body: string, callback: (error?: Error) => void) { this.sent.push(body); callback() }
}
const endpoint = 'wss://api.sgroup.qq.com/websocket/'
function fixture(autoOpen = true) {
  const socket = new Socket()
  let settings: ClientOptions | undefined, lookups = 0
  const open = createQqSocketFactory({ allowDirect: true,
    resolve: async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }] },
    createSocket(url, options) {
      assert.equal(url, endpoint); settings = options
      if (autoOpen) queueMicrotask(() => socket.open())
      return socket as unknown as WebSocket
    },
  })
  return { socket, open, settings: () => settings!, lookups: () => lookups }
}

test('QQ实际socket工厂先固定公网DNS并禁跳转，消息与发送保持JSON协议', async () => {
  const f = fixture()
  const socket = await f.open(endpoint, new AbortController().signal)
  assert.equal(f.settings().followRedirects, false)
  assert.equal(f.lookups(), 1)
  const agent = f.settings().agent
  assert.ok(agent instanceof Agent)
  const pinned = await new Promise<unknown>((resolve, reject) => {
    agent.options.lookup!('api.sgroup.qq.com', { all: true }, (error, address) => error ? reject(error) : resolve(address))
  })
  assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }])
  const messages = socket.packets[Symbol.asyncIterator]()
  f.socket.emit('message', Buffer.from('{"op":10,"d":{"heartbeat_interval":1000}}'))
  assert.deepEqual((await messages.next()).value, { op: 10, d: { heartbeat_interval: 1000 } })
  await socket.send({ op: 1, d: 7 })
  assert.deepEqual(JSON.parse(f.socket.sent[0]!), { op: 1, d: 7 })
  await socket.close()
  assert.equal((await messages.next()).done, true)
})

test('QQ不允许非官方WS目标、凭据URL或公私混合DNS在握手前通过', async () => {
  let connections = 0
  const open = createQqSocketFactory({ allowDirect: true, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
    createSocket() { connections++; throw new Error('不应连接') } })
  for (const url of [endpoint, 'wss://example.invalid/websocket/', `${endpoint}?token=synthetic-token`,
    'wss://user:synthetic@api.sgroup.qq.com/websocket/', 'wss://api.sgroup.qq.com/other'])
    await assert.rejects(open(url, new AbortController().signal), /目标校验失败/)
  assert.equal(connections, 0)
})

test('QQ握手取消会关闭未ready连接，错误不会带出原始网络信息', async () => {
  const f = fixture(false)
  const controller = new AbortController()
  const opening = f.open(endpoint, controller.signal)
  for (let attempt = 0; attempt < 20 && !f.settings(); attempt++) await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(opening, /握手失败/)
  assert.equal(f.socket.stopped, true)
})

test('QQ接收坏JSON或超过缓冲上限会关闭并报告安全错误，已排队消息仍可按序消费', async () => {
  const f = fixture()
  const socket = await f.open(endpoint, new AbortController().signal)
  const messages = socket.packets[Symbol.asyncIterator]()
  for (let index = 0; index < 65; index++) f.socket.emit('message', Buffer.from(JSON.stringify({ op: 0, s: index })))
  assert.equal(f.socket.stopped, true)
  for (let index = 0; index < 64; index++) assert.equal(((await messages.next()).value as { s: number }).s, index)
  await assert.rejects(messages.next(), /接收失败/)
  await socket.close()
  const g = fixture()
  const other = await g.open(endpoint, new AbortController().signal)
  g.socket.emit('message', Buffer.from('合成无效JSON'))
  await assert.rejects(other.packets[Symbol.asyncIterator]().next(), /接收失败/)
  await other.close()
})
