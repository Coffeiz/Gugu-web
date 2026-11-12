import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { executionPolicy } from '../../../src/agent/executor/policy.js'
import { MxcExecutor } from '../../../src/agent/executor/mxc.js'
import { Executor } from '../../../src/agent/executor/platform.js'
import type {
  ExecutionGrant,
  ExecutionRequest,
} from '../../../src/agent/executor/contracts.js'

function fixture() {
  const request: ExecutionRequest = {
    id: randomUUID(),
    command: 'synthetic-command',
    cwd: '/synthetic/workspace',
    timeoutMs: 2000,
    destructive: false,
  }
  const grant: ExecutionGrant = {
    requestId: request.id,
    command: request.command,
    cwd: request.cwd,
    backend: 'mxc',
    confirmed: false,
    readonlyPaths: [request.cwd],
    readwritePaths: [],
    environment: {},
    timeoutMs: 5000,
    maxOutputBytes: 1024,
  }
  const capabilities = {
    filesystem: true,
    networkDeny: true,
    uiDeny: true,
    timeout: true,
    cancellation: true,
  }
  return { request, grant, capabilities }
}
describe('执行策略、能力隔离与原生回收', () => {
  it('授权绑定命令与请求，破坏性执行必须确认，策略快照不随原对象变化', () => {
    const { request, grant, capabilities } = fixture()
    expect(() =>
      executionPolicy({ ...request, command: '越权命令' }, grant, capabilities),
    ).toThrow('不匹配')
    expect(() =>
      executionPolicy({ ...request, destructive: true }, grant, capabilities),
    ).toThrow('需要确认')
    const policy = executionPolicy(
      { ...request, destructive: true },
      { ...grant, confirmed: true },
      capabilities,
    )
    expect(policy.timeoutMs).toBe(2000)
    ;(grant.readonlyPaths as string[]).push('/synthetic/private')
    expect(policy.readonlyPaths).toEqual(['/synthetic/workspace'])
    expect(() =>
      executionPolicy(request, grant, { ...capabilities, uiDeny: false }),
    ).toThrow('无法落实')
    expect(() =>
      executionPolicy(
        request,
        { ...grant, environment: { NODE_OPTIONS: '--unsafe' } },
        capabilities,
      ),
    ).toThrow('环境无效')
  })
  it('缺能力不改用宿主后端，发起过的执行不得自动重放', async () => {
    const { request, grant, capabilities } = fixture(),
      execute = vi.fn(async () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }))
    const executor = new Executor([{ id: 'mxc', capabilities, execute }])
    await expect(
      executor.execute(request, { ...grant, backend: 'missing' }),
    ).rejects.toMatchObject({ code: 'unsupported' })
    expect(execute).not.toHaveBeenCalled()
    await executor.execute(request, grant)
    await expect(executor.execute(request, grant)).rejects.toMatchObject({
      code: 'denied',
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('MXC 请求显式拒绝网络/UI 且不继承宿主环境，输出按字节限额', async () => {
    const { request, grant, capabilities } = fixture(),
      stdout = new PassThrough(),
      stderr = new PassThrough(),
      kill = vi.fn(),
      dispose = vi.fn()
    const spawn = vi.fn(async () => ({
      standardOutput: stdout,
      standardError: stderr,
      kill,
      dispose,
      wait: async () => {
        stdout.write(Buffer.from('😀'))
        stdout.end()
        stderr.end()
        return { exitCode: 0, timedOut: false }
      },
    }))
    const executor = new MxcExecutor(spawn)
    expect(
      await executor.execute(executionPolicy(request, grant, capabilities)),
    ).toMatchObject({ stdout: '😀', exitCode: 0 })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        ui: { disable: true, clipboard: 'none', injection: false },
        inheritDefaultEnvironment: false,
        environment: {},
        timeoutMs: 2000,
        network: {
          egress: { default: 'deny' },
          ingress: { default: 'deny', hostLoopback: 'deny' },
        },
      }),
    )
    expect(dispose).toHaveBeenCalledTimes(1)
    const output = new PassThrough(),
      limited = new MxcExecutor(async () => ({
        standardOutput: output,
        standardError: null,
        kill,
        dispose,
        wait: async () => {
          output.write('😀')
          return { exitCode: 0, timedOut: false }
        },
      }))
    await expect(
      limited.execute(
        executionPolicy(request, { ...grant, maxOutputBytes: 3 }, capabilities),
      ),
    ).rejects.toMatchObject({ code: 'output_limit' })
    expect(kill).toHaveBeenCalled()
  })
  it('取消会终止并回收原生进程，启动/回收错误不包含原始敏感内容', async () => {
    const { request, grant, capabilities } = fixture(),
      controller = new AbortController(),
      kill = vi.fn(),
      dispose = vi.fn()
    const cancelled = new MxcExecutor(async () => ({
      standardOutput: null,
      standardError: null,
      kill,
      dispose,
      wait: async () => {
        controller.abort()
        return { exitCode: 1, timedOut: false }
      },
    }))
    await expect(
      cancelled.execute(executionPolicy(request, grant, capabilities), controller.signal),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(kill).toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    const broken = new MxcExecutor(async () => {
      throw new Error('合成私有正文')
    })
    await expect(
      broken.execute(executionPolicy(request, grant, capabilities)),
    ).rejects.toThrow('原生执行失败')
    const cleanup = new MxcExecutor(async () => ({
      standardOutput: null,
      standardError: null,
      kill,
      dispose: () => {
        throw new Error('合成私有正文')
      },
      wait: async () => ({ exitCode: 0, timedOut: false }),
    }))
    await expect(
      cleanup.execute(executionPolicy(request, grant, capabilities)),
    ).rejects.toThrow('原生资源回收失败')
  })
})
