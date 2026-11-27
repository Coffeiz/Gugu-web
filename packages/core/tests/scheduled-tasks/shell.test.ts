import { expect, it, vi } from 'vitest'
import { createScheduledShell, type ScheduledShellAuthorization, type ScheduledShellBinding } from '../../src/agent/scenes/task/shell.js'
import type { ToolScope } from '../../src/agent/tools/contracts.js'

const facts = {
  adminEnabled: true, userEnabled: true, sandboxEnabled: true, sandboxReady: true,
  sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
  fullUserSandboxWrite: false, adminDangerousEnabled: true, userDangerousEnabled: true,
}

function setup(workspaceId: number | null = 1, systemEnabled = false) {
  let authorization: ScheduledShellAuthorization | null = { revision: 'grant-1', workspaceId, filesystemGrantId: null, facts, systemEnabled }
  const execute = vi.fn<ScheduledShellBinding['execute']>(async (_input, options) => {
    await options.assertAuthorized()
    return { kind: 'completed' as const, successful: true, executed: true, mutated: false, value: {} }
  })
  const shell = createScheduledShell({ read: async () => authorization, execute, supportsSandboxWrites: true, supportsSystem: true }, async () => {}, async () => true)
  const scope = { signal: new AbortController().signal } as ToolScope
  return {
    ...shell, execute,
    revoke() { authorization = null },
    run(command: string, scopeName: 'sandbox' | 'system' = 'sandbox') {
      const input = { command, scope: scopeName }
      return shell.tool.execute(input, scope, { id: 'call-1', name: 'shell', input })
    },
  }
}

it('任务 Shell 共用主工具定义，撤权后不再发现或执行', async () => {
  const shell = setup()
  expect(shell.tool.definition.name).toBe('shell')
  expect(await shell.available()).toBe(true)
  expect(await shell.run('pwd')).toMatchObject({ executed: true })
  shell.revoke()
  expect(await shell.available()).toBe(false)
  expect(await shell.run('pwd')).toMatchObject({ executed: false })
  expect(shell.execute).toHaveBeenCalledTimes(1)
})

it('沿用主 Agent 危险命令权限并在执行前复核状态', async () => {
  const shell = setup()
  expect(await shell.run('mkdir reports')).toMatchObject({ executed: true })
  let started = false
  shell.execute.mockImplementationOnce(async (_input, options) => {
    shell.revoke()
    await options.assertAuthorized()
    started = true
    throw new Error('不应进入执行端口')
  })
  await expect(shell.run('pwd')).rejects.toThrow('授权已变化')
  expect(started).toBe(false)
})

it('无工作区且无任务文件授权时不开放 Shell', async () => {
  const shell = setup(null)
  expect(await shell.available()).toBe(false)
  expect(await shell.run('pwd')).toMatchObject({ executed: false })
  expect(shell.execute).not.toHaveBeenCalled()
})

it('宿主机范围直接沿用 Shell 运行开关', async () => {
  const disabled = setup(1, false)
  expect(await disabled.run('pwd', 'system')).toMatchObject({ executed: false })
  const enabled = setup(1, true)
  expect(await enabled.run('pwd', 'system')).toMatchObject({ executed: true })
  expect(enabled.execute).toHaveBeenCalledTimes(1)
})

it('主 Agent 已开放宿主 Shell 时，任务无需另绑工作区或文件授权', async () => {
  const shell = setup(null, true)
  expect(await shell.available()).toBe(true)
  expect(await shell.run('pwd')).toMatchObject({ executed: false })
  expect(await shell.run('pwd', 'system')).toMatchObject({ executed: true })
  shell.revoke()
  expect(await shell.available()).toBe(false)
  expect(await shell.run('pwd', 'system')).toMatchObject({ executed: false })
  expect(shell.execute).toHaveBeenCalledTimes(1)
})
