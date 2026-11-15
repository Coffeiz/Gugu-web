import assert from 'node:assert/strict'
import test from 'node:test'
import { processOneInteraction, createInteractionRecoveryWorker, type InteractionWorkerPorts } from '../../src/domains/agent-sessions/agent-interaction-worker.js'
const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
const item = { identity, promptId: 1, claimToken: 'claim', secretServerId: null, resolution: { interactionId: 'interaction', receiptId: 'receipt', status: 'confirmed' as const, value: null } }
function setup(status: 'running' | 'cancelled', consumed: boolean) {
  let released = 0, finished = 0, resumed = 0, state: 'running' | 'cancelled' | 'completed' = status
  const ports: InteractionWorkerPorts = { queue: { claim: async () => item, releaseClaim: async () => { released++ }, finishClaim: async () => { finished++; return true }, isConsumed: async () => consumed },
    read: async () => ({ status: state }), invalidateCredential: async () => {}, diagnose() {},
    async *resume(_identity, resolution) { assert.equal(resolution, undefined); resumed++; state = 'completed' } }
  return { ports, counts: () => [released, finished, resumed] }
}
test('收据已提交后进程退出，恢复 run 而不再次递交回答', async () => {
  const { ports, counts } = setup('running', true)
  await processOneInteraction(ports); assert.deepEqual(counts(), [1, 1, 1])
})
test('运行已取消时不恢复工具但关闭待处理项', async () => {
  const { ports, counts } = setup('cancelled', false)
  await processOneInteraction(ports); assert.deepEqual(counts(), [1, 1, 0])
})
test('停止空闲 worker 立即结束轮询', async () => {
  const { ports } = setup('running', false)
  ports.queue.claim = async () => null
  const worker = createInteractionRecoveryWorker(ports, 60000)
  worker.start(); await worker.stop()
})
