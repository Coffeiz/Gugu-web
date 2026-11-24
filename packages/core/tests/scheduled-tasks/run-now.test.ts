import { describe, expect, it, vi } from 'vitest'
import { ScheduledTaskRunner } from '../../src/scheduled-tasks/runner.js'
import type { OnceTaskRepository, ScheduledTaskExecutionCallback, ScheduledTaskLease } from '../../src/scheduled-tasks/runner.js'
import { createScheduledTaskAgentAttempt, createScheduledTaskExecution, createScheduledTaskRunNow,
  scheduledTaskProviderSelection, scheduledTaskSupportsFileDelivery } from '../../src/scheduled-tasks/run-now.js'
import { fixture, identity, toolCall, usage } from '../agent/run/fixtures.js'
import type { ProviderEvent } from '../../src/agent/models.js'
import { ExecutionError } from '../../src/agent/executor/contracts.js'

const task = {
  id: '42', ownerId: 'owner-a', name: '测试任务', payload: '查看最新计划', channels: ['web', 'chat', 'qq'],
  deliveryTargets: {}, authorizedTools: [], emailAttachmentFilePaths: [], workspaceId: null, filesystemGrantId: null,
}

it('定时运行禁用推理续接并保留Host选中的模型与凭据', () => {
  const selected = {
    modelIdentity: 'synthetic-model', accessScopeHash: 'synthetic-scope', systemPrompt: '合成提示词',
    config: { provider: 'openai', model: 'synthetic-model', api_key: 'synthetic-secret', reasoning_persistence: 'continuation' },
  }
  expect(scheduledTaskProviderSelection(selected)).toEqual({
    ...selected, config: { ...selected.config, reasoning_persistence: 'off' },
  })
  expect(selected.config.reasoning_persistence).toBe('continuation')
})

it('only offers send_file when a selected delivery channel can receive result attachments', () => {
  expect(scheduledTaskSupportsFileDelivery(['telegram'])).toBe(true)
  expect(scheduledTaskSupportsFileDelivery(['web', 'chat'])).toBe(false)
  expect(scheduledTaskSupportsFileDelivery(['web', 'email'])).toBe(true)
})

describe('scheduled task execution', () => {
  it.each(['success', 'partial_delivery', 'unresolved_tool', 'edited', 'trial'] as const)(
    '周期任务仅在主动请求、所有渠道成功且版本仍匹配时停用（%s）', async scenario => {
      const recurring = { ...task, channels: ['web', 'email'] }
      const seen: string[] = []
      const run = createScheduledTaskExecution({
        async attempt(input) {
          const tool = input.toolsForRun?.(identity).find(tool => tool.definition.name === 'stop_recurring')
          if (scenario === 'trial') expect(tool).toBeUndefined()
          else {
            expect(tool).toBeDefined()
            const result = await tool!.execute({}, { identity, signal: new AbortController().signal } as never, {
              id: 'stop', name: 'stop_recurring', input: {},
            })
            expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: false })
            expect(seen).toEqual([])
          }
          return { text: '报告', status: 'success', effects: 'none', files: [],
            unresolvedToolErrors: scenario === 'unresolved_tool' }
        },
        async deliver() { seen.push('trial'); return {} },
      })
      await run(recurring, scenario === 'trial', async () => {}, {
        async deliver(_outcome, _lease, noticeTitle) {
          seen.push(noticeTitle ? 'notice' : 'result')
          return { 'web 通知': '已保存（实时提示失败）', 邮件: scenario === 'partial_delivery' ? '发送失败' : '已发送' }
        },
        async disable() { seen.push('disable'); return scenario !== 'edited' },
        async notifyChanged() { seen.push('refresh') },
      })
      expect(seen).toEqual(scenario === 'success' ? ['result', 'disable', 'refresh', 'notice']
        : scenario === 'edited' ? ['result', 'disable']
          : scenario === 'trial' ? ['trial'] : ['result'])
    },
  )

  it('由完整 Agent 续轮取最后正文和文件，而非拼接中间模型文案', async () => {
    const f = fixture([
      [{ type: 'complete', text: '正在整理', calls: [toolCall] }],
      [{ type: 'complete', text: '## 最终报告', calls: [] }],
    ])
    const artifact = { attach_id: 'synthetic-file', name: '报告', ext: 'txt' }
    vi.mocked(f.ports.tools.dispatch).mockResolvedValue({
      kind: 'completed', value: '合成工具结果', successful: true, mutated: false, artifact,
    })
    const close = vi.fn(async () => {})
    const prepare = vi.fn(async () => ({ identity, harness: f.harness, close }))
    const attempt = createScheduledTaskAgentAttempt(prepare)
    const deliver = vi.fn(async () => ({ 'web 通知': '已发送' }))
    const run = createScheduledTaskExecution({ attempt, deliver })
    await expect(run({ ...task, ownerId: identity.ownerId }, true)).resolves.toEqual({ 'web 通知': '已发送' })
    expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      task: expect.objectContaining({ id: '42', ownerId: identity.ownerId }), isTrial: true,
      prompt: expect.stringContaining('查看最新计划'),
    }))
    expect(f.ports.tools.dispatch).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: '42' }), {
      text: '## 最终报告', status: 'success', files: [artifact],
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([false, true])('Agent 续轮失败后按实际写入回执决定重试，mutated=%s', async mutated => {
    const rounds: ProviderEvent[][] = [
      [{ type: 'usage', usage }, { type: 'complete', text: '中间正文', calls: [toolCall] }],
      [{ type: 'error', error: new Error('合成 Provider 故障') }],
    ]
    const failed = fixture(rounds)
    vi.mocked(failed.ports.tools.dispatch).mockResolvedValue({
      kind: 'completed', value: '合成工具结果', successful: true, mutated,
    })
    const retried = fixture()
    const close = vi.fn(async () => {})
    const recordUsage = vi.fn(async () => {})
    const prepare = vi.fn().mockResolvedValueOnce({ identity, harness: failed.harness, close, recordUsage })
      .mockResolvedValueOnce({ identity: { ...identity, runId: 'retry-run' }, harness: retried.harness, close, recordUsage })
    const deliver = vi.fn(async () => ({ 'web 通知': '已发送' }))
    const run = createScheduledTaskExecution({ attempt: createScheduledTaskAgentAttempt(prepare), deliver })
    await run({ ...task, ownerId: identity.ownerId }, false)
    expect(prepare).toHaveBeenCalledTimes(mutated ? 1 : 2)
    expect(close).toHaveBeenCalledTimes(mutated ? 1 : 2)
    expect(recordUsage).toHaveBeenCalledTimes(mutated ? 1 : 2)
    expect(recordUsage).toHaveBeenNthCalledWith(1, expect.objectContaining({ identity, status: 'failed', totalUsage: usage }))
    if (!mutated) expect(recordUsage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      identity: { ...identity, runId: 'retry-run' }, status: 'completed', totalUsage: usage,
    }))
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: '42' }), {
      text: mutated ? '上游暂时不可用' : '合成回复', status: mutated ? 'failed' : 'success', files: [],
    })
  })

  it('拒绝启动异主 Agent 运行，并释放准备阶段资源', async () => {
    const f = fixture()
    const close = vi.fn(async () => {})
    const attempt = createScheduledTaskAgentAttempt(async () => ({ identity, harness: f.harness, close }))
    await expect(attempt({ task, prompt: '合成', isTrial: true })).rejects.toThrow('定时任务执行身份不匹配')
    expect(f.ports.provider.stream).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('执行后丢失工具回执时，不自动重放或把不确定结果投递为已完成', async () => {
    const f = fixture([[{ type: 'complete', text: '', calls: [toolCall] }]])
    f.ports.execution.execute = vi.fn(async () => { throw new ExecutionError('native_failure', '合成回执丢失') })
    vi.mocked(f.ports.tools.dispatch).mockImplementation(async (_call, scope) => {
      await scope.execute({ id: 'synthetic-execution', command: '合成命令', cwd: '/synthetic', timeoutMs: 10, destructive: false })
      return { kind: 'completed', value: '未到达', successful: true, mutated: false }
    })
    const close = vi.fn(async () => {})
    const prepare = vi.fn(async () => ({ identity, harness: f.harness, close }))
    const deliver = vi.fn()
    const run = createScheduledTaskExecution({ attempt: createScheduledTaskAgentAttempt(prepare), deliver })
    await expect(run({ ...task, ownerId: identity.ownerId }, false)).rejects.toThrow('定时任务执行未正常结束')
    expect(f.ports.execution.execute).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(deliver).not.toHaveBeenCalled()
  })

  it('无写入的失败只重试一次，原样投递最终正文和有效附件', async () => {
    const attempt = vi.fn()
      .mockResolvedValueOnce({ text: '第一次失败', status: 'failed', effects: 'none', files: [{ id: 'kept-file' }] })
      .mockResolvedValueOnce({ text: '## 最终结果\n- 合成计划', status: 'success', effects: 'none', files: [] })
    const deliver = vi.fn(async () => ({ 'web 通知': '已发送' }))
    const run = createScheduledTaskExecution({ attempt, deliver, timeZone: 'Asia/Shanghai',
      now: () => new Date('2026-11-18T00:30:00Z') })
    expect(await run(task, true)).toEqual({ 'web 通知': '已发送' })
    expect(attempt).toHaveBeenCalledTimes(2)
    const input = attempt.mock.calls[0]![0]
    expect(input).toMatchObject({ task, isTrial: true })
    expect(input.prompt).toContain('现在是 2026-11-18 08:30，用户设置了一条定时任务：查看最新计划')
    expect(input.prompt).toContain('本轮消息将由系统投递到：网页通知、QQ。')
    expect(input.prompt).not.toContain('报告 schema')
    expect(deliver).toHaveBeenCalledExactlyOnceWith(task, { text: '## 最终结果\n- 合成计划',
      status: 'success', files: [{ id: 'kept-file' }] })
  })

  it('可能写入的失败不重放，异常也不重放并交回 Runner 结算', async () => {
    const attempt = vi.fn().mockResolvedValueOnce({ text: '写入后执行失败', status: 'failed', effects: 'possible', files: [] })
    const deliver = vi.fn(async () => ({ 'web 通知': '已发送' }))
    const run = createScheduledTaskExecution({ attempt, deliver })
    await run(task, false)
    expect(attempt).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledExactlyOnceWith(task, { text: '写入后执行失败', status: 'failed', files: [] })
    attempt.mockRejectedValueOnce(new Error('合成异常'))
    await expect(run(task, false)).rejects.toThrow('合成异常')
    expect(attempt).toHaveBeenCalledTimes(2)
    expect(deliver).toHaveBeenCalledOnce()
  })
})

describe('scheduled task run now', () => {
  it('普通任务走试运行，不推进调度状态并返回渠道结果', async () => {
    const runTrial = vi.fn(async (_taskId: string, execute: ScheduledTaskExecutionCallback) => ({
      status: 'completed' as const,
      delivery: await execute(async () => {}),
    }))
    const runDue = vi.fn()
    const execute = vi.fn(async () => ({ 网页通知: '已发送' }))
    const run = createScheduledTaskRunNow({
      readOwned: async () => ({ scheduleKind: 'cron', enabled: true, endAt: null, lastRunFailed: false }),
      runner: { runTrial, runDue },
      prepare: async () => ({ execute }),
      now: () => 1000,
      waitSeconds: 1,
    })

    const result = await run('owner-a', '42')

    expect(runTrial).toHaveBeenCalledOnce()
    expect(runDue).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: true, result: { 网页通知: '已发送' } })
  })

  it('失败过的一次性任务走正式重试', async () => {
    const runDue = vi.fn(async (_taskId: string, execute: ScheduledTaskExecutionCallback, _now?: number, options?: { beforeStart?: () => Promise<boolean> }) => {
      if (options?.beforeStart && !await options.beforeStart()) return 'failed' as const
      await execute(async () => {})
      return 'completed' as const
    })
    const runTrial = vi.fn()
    const execute = vi.fn(async () => ({ QQ: '已发送' }))
    const run = createScheduledTaskRunNow({
      readOwned: async () => ({ scheduleKind: 'once', enabled: true, endAt: null, lastRunFailed: true }),
      runner: { runTrial, runDue },
      prepare: async () => ({ execute }),
      now: () => 1000,
      waitSeconds: 1,
    })

    const result = await run('owner-a', '42')

    expect(runDue).toHaveBeenCalledOnce()
    expect(runTrial).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: true, result: { QQ: '已发送' } })
  })

  it('异主和已结束任务不启动执行', async () => {
    const execute = vi.fn(async () => ({ 网页通知: '已发送' }))
    const base = {
      runner: { runTrial: vi.fn(), runDue: vi.fn() }, prepare: async () => ({ execute }), now: () => 1000, waitSeconds: 1,
    }
    const notFound = createScheduledTaskRunNow({ ...base, readOwned: async () => null })
    await expect(notFound('owner-a', '42')).rejects.toMatchObject({ code: 'not_found' })

    const ended = createScheduledTaskRunNow({
      ...base,
      readOwned: async () => ({ scheduleKind: 'interval', enabled: true, endAt: 999, lastRunFailed: false }),
    })
    expect(await ended('owner-a', '42')).toEqual({ ok: false, msg: '任务已结束，不能立即运行' })
    expect(execute).not.toHaveBeenCalled()
    expect(base.runner.runTrial).not.toHaveBeenCalled()
  })

  it('超过 HTTP 等待窗口后保留后台执行，不向执行器发送取消', async () => {
    let finish!: (value: Record<string, string>) => void
    const execute = vi.fn(() => new Promise<Record<string, string>>(resolve => { finish = resolve }))
    const run = createScheduledTaskRunNow({
      readOwned: async () => ({ scheduleKind: 'cron', enabled: true, endAt: null, lastRunFailed: false }),
      runner: {
        runTrial: async (_id, task) => ({ status: 'completed', delivery: await task(async () => {}) }),
        runDue: vi.fn(),
      }, prepare: async () => ({ execute }),
      now: () => 1000,
      waitSeconds: 0.01,
    })

    await expect(run('owner-a', '42')).resolves.toMatchObject({ ok: true, pending: true })
    expect(execute).toHaveBeenCalledOnce()
    finish({ 网页通知: '已发送' })
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('真实 Core runner 的试运行复用分布式租约但不改一次性任务状态', async () => {
    const history: string[] = []
    const repository: OnceTaskRepository = {
      async getOnce() { history.push('read'); return null },
      async markStarted() { history.push('started'); return true },
      async markFailed() { history.push('failed') },
      async deleteCompleted() { history.push('deleted') },
      async findStartedOnceBefore() { history.push('scan'); return [] },
    }
    const lease: ScheduledTaskLease = {
      async acquire(taskId, owner) { history.push(`acquire:${taskId}:${owner}`); return true },
      async renew() { history.push('renew'); return true },
      async release(taskId, owner) { history.push(`release:${taskId}:${owner}`) },
      async isHeld() { return false },
    }
    const runner = new ScheduledTaskRunner({ repository, lease, createOwner: () => 'lease-a', notifyTasksChanged: async () => { history.push('notify') } })

    const result = await runner.runTrial('42', async () => ({ 网页通知: '已发送' }))

    expect(result).toEqual({ status: 'completed', delivery: { 网页通知: '已发送' } })
    expect(history).toEqual(['acquire:42:lease-a', 'release:42:lease-a'])
  })
})

it.each(['success', 'failed'] as const)('模型返回 %s 前 Redis 租约已被接管时，旧运行不投递或重试', async status => {
  let token = ''
  const runner = new ScheduledTaskRunner({
    repository: {
      async getOnce() { return null },
      async markStarted() { return true },
      async markFailed() {},
      async deleteCompleted() {},
      async findStartedOnceBefore() { return [] },
    },
    lease: {
      async acquire(_id, owner) { token = owner; return true },
      async renew(_id, owner) { return token === owner },
      async release(_id, owner) { if (token === owner) token = '' },
      async isHeld() { return !!token },
    },
    createOwner: () => 'first',
    async notifyTasksChanged() {},
  })
  const attempt = vi.fn(async () => {
    token = 'replacement'
    return { text: '旧任务结果', status, effects: 'none' as const, files: [] }
  })
  const deliver = vi.fn(async () => ({ 网页通知: '已发送' }))
  const execute = createScheduledTaskExecution({ attempt, deliver })
  const run = createScheduledTaskRunNow({
    readOwned: async () => ({ scheduleKind: 'cron', enabled: true, endAt: null, lastRunFailed: false }),
    runner,
    prepare: async () => ({ execute: assertLease => execute(task, true, assertLease) }),
  })

  expect((await run(task.ownerId, task.id)).result).toEqual({ 错误: '任务执行租约已失效，请稍后重试' })
  expect(attempt).toHaveBeenCalledTimes(1)
  expect(deliver).not.toHaveBeenCalled()
  expect(token).toBe('replacement')
})
