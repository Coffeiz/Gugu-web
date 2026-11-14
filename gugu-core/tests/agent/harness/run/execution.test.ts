import { describe,expect,it,vi } from 'vitest'
import type { ExecutionGrant,ExecutionPolicy,ExecutionRequest } from "../../../../src/agent/executor/contracts.js"
import { Executor } from "../../../../src/agent/executor/executor.js"
import type { HarnessExecutionScope } from "../../../../src/agent/harness/index.js"
import { createHarnessExecutor } from "../../../../src/agent/harness/index.js"

const scope = {
  ownerId: '小北', sessionId: 'session-1', runId: 'run-1',
  roundId: 'round-1', toolCallId: 'call-1'
}

function fixture() {
  const request: ExecutionRequest = {
    id: '00000000-0000-4000-8000-000000000001',
    command: 'synthetic-command', cwd: '/synthetic/workspace',
    timeoutMs: 1000, destructive: false,
  }
  const grant: ExecutionGrant = {
    requestId: request.id, backend: 'test-adapter', command: request.command,
    cwd: request.cwd, confirmed: false, readonlyPaths: [request.cwd],
    readwritePaths: [], environment: {}, timeoutMs: 1000, maxOutputBytes: 1024,
  }
  const backend = {
    id: grant.backend, capabilities: {
      filesystem: true, networkDeny: true, uiDeny: true, timeout: true, cancellation: true,
    }, execute: vi.fn(async (_policy: ExecutionPolicy, _signal?: AbortSignal) => (
      { stdout: '合成结果', stderr: '', exitCode: 0, timedOut: false }
    ))
  }
  const authorize = vi.fn(async (_scope: HarnessExecutionScope,
    _request: Readonly<ExecutionRequest>, _signal?: AbortSignal) => grant)
  const diagnose = vi.fn()
  const executor = new Executor([backend])
  const harness = createHarnessExecutor({ authorize, executor, diagnose })
  return { request, grant, backend, authorize, executor, diagnose, harness }
}

describe('Harness 复用共用 Executor 的授权与执行边界', () => {
  it('每次传递可信 Run 身份和不可变请求，不接受未确认的破坏性执行', async () => {
    const { harness, request, authorize, backend } = fixture()
    await expect(harness.execute(scope, { ...request, destructive: true }))
      .rejects.toMatchObject({ code: 'denied' })
    expect(authorize).toHaveBeenCalledWith(scope, { ...request, destructive: true }, undefined)
    expect(Object.isFrozen(authorize.mock.calls[0]?.[0])).toBe(true)
    expect(backend.execute).not.toHaveBeenCalled()
  })

  it('授权等待期间修改调用对象不会改变待执行请求或所属 Run', async () => {
    const { request, grant, backend, executor } = fixture()
    const mutableScope = { ...scope }
    let release!: (value: ExecutionGrant) => void
    const harness = createHarnessExecutor({
      executor, authorize: async (receivedScope, received) => {
        expect(receivedScope.ownerId).toBe('小北')
        expect(received.command).toBe('synthetic-command')
        return new Promise<ExecutionGrant>((resolve) => { release = resolve })
      }
    })
    const result = harness.execute(mutableScope, request)
    request.command = '不同的合成命令'
    mutableScope.ownerId = '小南'
    release(grant)
    await expect(result).resolves.toMatchObject({ stdout: '合成结果' })
    expect(backend.execute.mock.calls[0]?.[0]).toMatchObject({ command: 'synthetic-command' })
  })

  it('缺失隔离能力拒绝执行，不降级；已执行 ID 不能重放', async () => {
    const first = fixture()
    first.backend.capabilities.networkDeny = false
    await expect(first.harness.execute(scope, first.request)).rejects.toMatchObject({ code: 'unsupported' })
    expect(first.backend.execute).not.toHaveBeenCalled()
    const second = fixture()
    await second.harness.execute(scope, second.request)
    await expect(second.harness.execute(scope, second.request)).rejects.toMatchObject({ code: 'denied' })
    expect(second.authorize).toHaveBeenCalledTimes(2)
    expect(second.backend.execute).toHaveBeenCalledTimes(1)
  })

  it('后端结果未知不自动重试，原始异常只交给受限诊断', async () => {
    const { harness, request, backend, diagnose } = fixture()
    backend.execute.mockRejectedValue(new Error('合成私有正文'))
    await expect(harness.execute(scope, request)).rejects.toMatchObject({
      code: 'native_failure', message: '执行后端失败，执行结果可能未知',
    })
    await expect(harness.execute(scope, request)).rejects.toMatchObject({ code: 'denied' })
    expect(backend.execute).toHaveBeenCalledTimes(1)
    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ message: '合成私有正文' }))
  })

  it('取消前拒绝授权，授权等待中取消也不触发执行', async () => {
    const first = fixture()
    const controller = new AbortController()
    controller.abort('合成私有取消原因')
    await expect(first.harness.execute(scope, first.request, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled', message: '执行已取消' })
    expect(first.authorize).not.toHaveBeenCalled()
    const second = fixture()
    const late = new AbortController()
    second.authorize.mockImplementation(async () => { late.abort(); return second.grant })
    await expect(second.harness.execute(scope, second.request, late.signal))
      .rejects.toMatchObject({ code: 'cancelled' })
    expect(second.backend.execute).not.toHaveBeenCalled()
  })

  it('未建立完整可信执行身份时不调用授权或后端', async () => {
    const { harness, request, authorize, backend } = fixture()
    await expect(harness.execute({ ...scope, ownerId: '' }, request))
      .rejects.toMatchObject({ code: 'denied' })
    expect(authorize).not.toHaveBeenCalled()
    expect(backend.execute).not.toHaveBeenCalled()
  })
})
