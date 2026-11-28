import { describe, expect, it, vi } from 'vitest'
import { createInteractionRecoveryWorker, processOneInteraction, type InteractionRecoveryPorts } from '../../../src/agent/index.js'

const identity = { ownerId: 'owner-synthetic', sessionId: '1', runId: 'run-synthetic' }
const item = { identity, promptId: 1, claimToken: 'claim-synthetic', secretServerId: null,
  resolution: { interactionId: 'interaction-synthetic', receiptId: 'receipt-synthetic', status: 'confirmed' as const, value: null } }

function setup(status: 'running' | 'cancelled', consumed: boolean) {
  let released = 0, finished = 0, resumed = 0
  let state: 'running' | 'cancelled' | 'completed' = status
  const ports: InteractionRecoveryPorts = {
    queue: { claim: async () => item, releaseClaim: async () => { released++ }, finishClaim: async () => { finished++; return true }, isConsumed: async () => consumed },
    read: async () => ({ status: state }), invalidateCredential: async () => {}, diagnose() {},
    async *resume(_identity, resolution) { expect(resolution).toBeUndefined(); resumed++; state = 'completed'; yield { identity, sequence: 1, type: 'final' } as never },
  }
  return { ports, counts: () => [released, finished, resumed] }
}

describe('Core Agent interaction recovery worker', () => {
  it('收据已提交后进程退出，恢复 Run 且不再次递交回答', async () => {
    const { ports, counts } = setup('running', true)
    await processOneInteraction(ports)
    expect(counts()).toEqual([1, 1, 1])
  })

  it('运行已取消时不恢复工具并关闭待处理项', async () => {
    const { ports, counts } = setup('cancelled', false)
    await processOneInteraction(ports)
    expect(counts()).toEqual([1, 1, 0])
  })

  it('停止空闲 worker 后立即结束轮询', async () => {
    const { ports } = setup('running', false)
    ports.queue.claim = async () => null
    const worker = createInteractionRecoveryWorker(ports, 60000)
    worker.start()
    await worker.stop()
  })

  it('恢复事件身份不匹配时释放认领并拒绝完成恢复', async () => {
    const { ports, counts } = setup('running', false)
    ports.resume = async function* () { yield { identity: { ...identity, ownerId: 'other-owner' }, sequence: 1, type: 'final' } as never }
    await expect(processOneInteraction(ports)).rejects.toThrow('运行身份不匹配')
    expect(counts()).toEqual([1, 0, 0])
  })
})
