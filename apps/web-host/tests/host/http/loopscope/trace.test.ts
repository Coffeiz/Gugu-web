import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebLoopScopeTrace } from '../../../../src/modules/loopscope/trace.js'

test('关闭 LoopScope trace 时不创建 Collector recorder 或发送请求', async () => {
  let requests = 0
  const trace = createWebLoopScopeTrace({ enabled: 'false', transport: { async request() { requests++; return { status: 200 } } } })
  assert.equal(trace, undefined)
  assert.equal(requests, 0)
})

test('开启后 Host 仅传 Core 通用观测到受信 Collector transport', async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  const trace = createWebLoopScopeTrace({ enabled: 'yes', endpoint: 'http://collector.test', transport: {
    async request(input) {
      requests.push({ url: input.url, body: input.body as Record<string, unknown> })
      return { status: 200, headers: {}, body: (async function* () {})(), cancel() {} }
    },
  } })
  assert.ok(trace)
  trace.observation.record({ identity: { ownerId: 'owner-fixture', sessionId: 'session-fixture', runId: 'run-fixture' },
    kind: 'run', name: 'started', at: 1_800_000_000_000, status: 'running', spanId: 'run-fixture' })
  await new Promise(resolve => setTimeout(resolve, 20))
  await trace.close()
  assert.equal(requests[0]?.url, 'http://collector.test/api/collector/runs')
  assert.equal(requests[0]?.body.session_key, 'gugu:web:session-fixture')
  assert.equal(JSON.stringify(requests).includes('owner-fixture'), false)
})
