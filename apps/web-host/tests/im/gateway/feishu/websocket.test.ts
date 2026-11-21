import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFeishuWsNetwork } from '@gugu/gateway/feishu'

const endpoint = 'wss://msg-frontier.feishu.cn/ws/v2?ticket=synthetic-ticket&device_id=synthetic-device&service_id=1'
const signal = () => new AbortController().signal

test('飞书WS复用DNS公有校验并固定同一次解析结果，不使用下一次DNS结果', async () => {
  let lookups = 0
  const network = createFeishuWsNetwork({ allowDirect: true, resolve: async () => {
    lookups++; return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]
  } })
  await network.validateEndpoint(endpoint, signal())
  const lookup = network.agent.options.lookup!
  const pinned = await new Promise<unknown>((resolve, reject) => {
    lookup('msg-frontier.feishu.cn', { all: true }, (error, address) => error ? reject(error) : resolve(address))
  })
  assert.deepEqual(pinned, [{ address: '8.8.8.8', family: 4 }])
  assert.equal(lookups, 1)
  await assert.rejects(network.validateEndpoint(endpoint, signal()), error => error instanceof Error && !error.message.includes('ticket'))
  network.close()
  await new Promise<void>(resolve => { lookup('msg-frontier.feishu.cn', {}, error => { assert.ok(error); resolve() }) })
})

test('飞书WS拒绝其他主机、凭据URL、路径、端口及混合公私DNS，不发起真实连接', async () => {
  const network = createFeishuWsNetwork({ allowDirect: true, resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] })
  for (const url of [endpoint, 'wss://example.invalid/ws/v2', 'wss://msg-frontier.feishu.cn:8443/ws/v2',
    'wss://user:password@msg-frontier.feishu.cn/ws/v2', 'wss://msg-frontier.feishu.cn/ws/other',
    'wss://msg-frontier.feishu.cn/ws/v2?token=synthetic-token'])
    await assert.rejects(network.validateEndpoint(url, signal()), /目标校验失败/)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(network.validateEndpoint(endpoint, cancelled.signal), /目标校验失败/)
  network.close()
})
