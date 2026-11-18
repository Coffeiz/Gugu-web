import { expect, it } from 'vitest'
import { createAgentRunStateReader } from '../../../src/agent/index.js'

const identity = { ownerId: 'owner-synthetic', sessionId: '1', runId: 'synthetic-run' }

it('共享 Run 状态保留 checkpoint 序号和终态，暂时重建失败仅覆盖进行中的运行', async () => {
  let checkpoint: { sequence: number; status: string } | null = { sequence: 4, status: 'running' }
  let blocked: 'version_conflict' | null = null
  const read = createAgentRunStateReader(
    { async read(owner) { expect(owner).toEqual(identity); return checkpoint } },
    { async readFailure() { return true } },
    { async readReconstructionStatus() { return blocked } },
  )
  expect(await read(identity)).toEqual({ sequence: 4, status: 'running' })
  blocked = 'version_conflict'
  expect(await read(identity)).toEqual({ sequence: 4, status: 'reconstruction_version_conflict' })
  checkpoint = { sequence: 5, status: 'completed' }
  expect(await read(identity)).toEqual({ sequence: 5, status: 'completed' })
  checkpoint = null
  expect(await read(identity)).toEqual({ sequence: 0, status: 'reconstruction_version_conflict' })
  blocked = null
  expect(await read(identity)).toEqual({ sequence: 0, status: 'startup_failed' })
})

it('checkpoint 读取故障原样传播，避免生成虚假的启动失败', async () => {
  const failure = new Error('合成 checkpoint 读取故障')
  const read = createAgentRunStateReader(
    { async read() { throw failure } },
    { async readFailure() { return true } },
  )
  await expect(read(identity)).rejects.toBe(failure)
})
