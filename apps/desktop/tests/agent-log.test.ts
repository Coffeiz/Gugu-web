import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { collect, fixture, identity } from '../../../packages/core/tests/agent/run/fixtures.js'
import { createWebRuntimeLog } from '../../web-host/src/shared/log-files.js'
import { sandboxDiagnostics } from '../src/sandbox/diagnostics.js'
import { createWebAgentLog } from '../../web-host/src/modules/agent/run/diagnostics.js'
import { createDesktopAgentLog, createDesktopRuntimeLog } from '../src/main/log/index.js'

test('同一 Core Runner 在两端输出一致的脱敏事件和关联诊断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-logs-'))
  const desktop = join(root, 'desktop')
  const web = join(root, 'web')
  try {
    for (const host of [createDesktopAgentLog(desktop), createWebAgentLog(join(web, 'gugu.log'), () => '0123456789abcdef')]) {
      const success = fixture()
      Object.assign(success.ports, host)
      expect((await collect(success.harness.start(identity))).state.status).toBe('completed')
      const failure = fixture()
      Object.assign(failure.ports, host)
      failure.ports.context.prepare = async () => { throw new Error('合成正文与 api_key=synthetic-secret') }
      expect((await collect(failure.harness.start(identity))).state.status).toBe('failed')
    }

    const outputs = []
    for (const directory of [join(desktop, 'logs'), web]) {
      const [regular, diagnostic] = await Promise.all([
        readFile(join(directory, 'gugu.log'), 'utf8'),
        readFile(join(directory, 'gugu-diag.log'), 'utf8'),
      ])
      expect(regular + diagnostic).not.toMatch(/合成正文|合成回复|synthetic-secret|owner-synthetic/)
      const records = regular.trim().split('\n').map(line => JSON.parse(line))
      const failed = records.find(record => record.event === 'agent.run.failure')
      expect(records.some(record => record.event === 'agent.provider.round_result')).toBe(true)
      expect(failed).toMatchObject({ attributes: { phase: 'prepare', errorCode: 'internal_error' } })
      expect(JSON.parse(diagnostic)).toMatchObject({ run: failed.run, frames: expect.any(Array) })
      outputs.push(records.map(record => ({
        level: record.level, event: record.event, round: record.round, attributes: record.attributes,
      })))
    }
    expect(outputs[0]).toEqual(outputs[1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('两端宿主与沙箱诊断遵循相同字段约束，关联详情只写入诊断文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-runtime-logs-'))
  const desktop = join(root, 'desktop')
  const web = join(root, 'web')
  try {
    for (const report of [createDesktopRuntimeLog(desktop), createWebRuntimeLog(join(web, 'gugu.log'))]) {
      report('host.started')
      report('gateway.degraded', { code: 'synthetic-bot-secret' })
      const failure = new Error('synthetic-user-command')
      await expect(sandboxDiagnostics({ request: async () => { throw failure } }, report)).rejects.toBe(failure)
    }
    const outputs = []
    for (const directory of [join(desktop, 'logs'), web]) {
      const regular = await readFile(join(directory, 'gugu.log'), 'utf8')
      const diagnostic = await readFile(join(directory, 'gugu-diag.log'), 'utf8')
      expect(regular + diagnostic).not.toMatch(/synthetic-user-command|synthetic-bot-secret/)
      const records = regular.trim().split('\n').map(line => JSON.parse(line))
      expect(records[1].attributes).toEqual({ code: 'unknown' })
      expect(records[2]).not.toHaveProperty('frames')
      expect(JSON.parse(diagnostic)).toMatchObject({ event: 'sandbox.probe_failed', incident: records[2].incident })
      outputs.push(records.map(({ event, level, attributes }) => ({ event, level, attributes })))
    }
    expect(outputs[0]).toEqual(outputs[1])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
