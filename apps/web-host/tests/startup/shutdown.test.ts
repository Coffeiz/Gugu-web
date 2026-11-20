import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeLog } from '@gugu/log/runtime'
import { shutdownStep } from '../../src/shared/shutdown.js'

test('停机卡在清理阶段时先记录慢阶段，继续等待清理完成', async () => {
  const records: string[] = []
  const report = createRuntimeLog({ regular: line => records.push(line), diagnostic: () => {} })
  const pending = Promise.withResolvers<void>()
  const close = shutdownStep(report, 'agent_runs', () => pending.promise, 0)
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  assert.deepEqual(records.map(line => JSON.parse(line).event),
    ['host.shutdown_phase_started', 'host.shutdown_phase_slow'])
  assert.equal(JSON.parse(records[1]!).attributes.phase, 'agent_runs')
  pending.resolve()
  await close
  assert.equal(JSON.parse(records[2]!).event, 'host.shutdown_phase_finished')
})

test('清理失败保留阶段和脱敏错误，并将异常交还给调用方', async () => {
  const records: string[] = []
  const report = createRuntimeLog({ regular: line => records.push(line), diagnostic: line => records.push(line) })
  const error = new Error('合成的私有异常正文')
  await assert.rejects(shutdownStep(report, 'postgres_pool', async () => { throw error }), value => value === error)
  assert.equal(JSON.parse(records[1]!).event, 'host.shutdown_phase_failed')
  assert.equal(JSON.parse(records[1]!).attributes.phase, 'postgres_pool')
  assert.doesNotMatch(records.join(''), /合成的私有异常正文/)
})
