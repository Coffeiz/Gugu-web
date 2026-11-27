import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { formatToolResult } from '../../src/agent/providers/tool-result-format.js'
import { createHostShellGrants, shellConfirmationMode } from '../../src/agent/security/shell-policy.js'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/data/schema.js'
import type { createSqliteToolConfirmation } from '../../src/agent/interactions/sqlite-confirmation.js'
import type { ToolScope } from '../../src/agent/tools/contracts.js'
import { createDesktopShellTool } from '../../src/runtime/desktop-shell.js'

vi.mock('@gugu/sandbox/desktop', () => ({
  desktopShellPlatform: () => platform,
}))

const platform = {
  id: 'synthetic-desktop',
  method: 'seatbelt',
  diagnostics: vi.fn(),
  createExecutor: vi.fn(),
  command: vi.fn(),
}

it('隔离不可用时拒绝隔离命令，宿主命令仍须明确确认', async () => {
  const db = {} as Kysely<Database>
  const prepare = vi.fn(async () => ({ ok: true, value: { id: 'synthetic-intent' } }))
  const confirmation = { gate: { prepare } } as unknown as ReturnType<typeof createSqliteToolConfirmation>
  const digest = (value: unknown) => JSON.stringify(value)
  const access = async () => ({ automaticMode: false, shellEnabled: true, dangerousEnabled: true })
  platform.diagnostics.mockResolvedValue({ supported: false, methods: [], checkAvailable: true })
  const tool = await createDesktopShellTool(db, confirmation, digest, access)
  const call = { id: 'call', name: 'shell', input: { command: 'pwd' } }
  const scope: ToolScope = {
    identity: { ownerId: 'owner', sessionId: '1', runId: 'run' },
    roundId: 'round', signal: new AbortController().signal, resolution: null,
    async execute() { throw new Error('未确认命令不可执行') },
  }
  expect(tool!.validate({ ...call.input, scope: 'system' }).success).toBe(false)
  expect(tool!.validate({ command: 'x'.repeat(16_385) }).success).toBe(false)
  const hiddenCommand = { command: 'pwd\u202epwd', cwd: tmpdir() }
  expect(await tool!.execute(hiddenCommand, scope, { ...call, input: hiddenCommand })).toMatchObject({ executed: false })
  expect(prepare).not.toHaveBeenCalled()
  expect(await tool!.execute(call.input, scope, call)).toMatchObject({ executed: false })
  const hostInput = { command: `pwd\n# ${'x'.repeat(1500)}\npwd`, cwd: tmpdir() }
  expect(await tool!.execute(hostInput, scope, { ...call, input: hostInput })).toEqual({ kind: 'waiting', interaction: { id: 'synthetic-intent' } })
  expect(prepare).toHaveBeenCalledOnce()
  expect(platform.createExecutor).not.toHaveBeenCalled()

  const automaticInput = {
    ...hostInput,
    command: process.platform === 'win32'
      ? 'echo desktop-host-shell-start && echo desktop-host-shell-end'
      : `echo desktop-host-shell-start\n# ${'x'.repeat(1500)}\necho desktop-host-shell-end`,
  }
  let automaticMode = true
  const autoTool = await createDesktopShellTool(db, confirmation, digest, async () => ({ ...await access(), automaticMode }))
  expect(await autoTool!.execute(automaticInput, scope, { ...call, input: automaticInput })).toMatchObject({
    kind: 'completed', successful: true, value: { scope: 'system', stdout: expect.stringMatching(/desktop-host-shell-start *\r?\ndesktop-host-shell-end/u) },
  })
  expect(prepare).toHaveBeenCalledOnce()
  await expect(autoTool!.execute(call.input, scope, call)).resolves.toMatchObject({ executed: false })
  expect(prepare).toHaveBeenCalledOnce()
  automaticMode = false
  expect(await autoTool!.execute(automaticInput, scope, { ...call, input: automaticInput })).toMatchObject({ kind: 'waiting' })
  expect(prepare).toHaveBeenCalledTimes(2)
})

it('会话绑定工作区后，默认目录和工作区子目录走隔离，显式外部目录要求确认', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'gugu-shell-workspace-'))
  const child = join(directory, 'child')
  await mkdir(child)
  const prepare = vi.fn(async () => ({ ok: true, value: { id: 'synthetic-intent' } }))
  const confirmation = { gate: { prepare } } as unknown as ReturnType<typeof createSqliteToolConfirmation>
  platform.diagnostics.mockResolvedValue({ supported: true, methods: [platform.method] })
  platform.createExecutor.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
  try {
    const tool = await createDesktopShellTool({} as Kysely<Database>, confirmation, JSON.stringify,
      async () => ({ automaticMode: false, shellEnabled: true, dangerousEnabled: true }),
      async () => ({ path: directory, identity: 'synthetic-workspace' }))
    const scope: ToolScope = {
      identity: { ownerId: 'owner', sessionId: 'workspace', runId: 'run' },
      roundId: 'round', signal: new AbortController().signal, resolution: null,
      async execute() { throw new Error('不执行测试命令') },
    }
    for (const cwd of [undefined, 'child', child]) {
      const input = { command: 'pwd', ...(cwd ? { cwd } : {}) }
      expect(await tool!.execute(input, scope, { id: 'call', name: 'shell', input }))
        .toMatchObject({ value: { error: '桌面原生隔离不可用' } })
    }
    expect(prepare).not.toHaveBeenCalled()
    const input = { command: 'pwd', cwd: tmpdir() }
    expect(await tool!.execute(input, scope, { id: 'call', name: 'shell', input })).toMatchObject({ kind: 'waiting' })
    expect(prepare).toHaveBeenCalledOnce()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('宿主机授权在同一会话跨 Run 使用，读取不续期且不跨用户和会话', () => {
  let now = 0
  const grants = createHostShellGrants(30 * 60 * 1000, () => now)
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
  grants.approve(identity, 'access')
  now = 29 * 60 * 1000
  expect(grants.permits({ ...identity, runId: 'next' }, 'access')).toBe(true)
  expect(grants.permits({ ...identity, ownerId: 'other' }, 'access')).toBe(false)
  expect(grants.permits({ ...identity, sessionId: '2' }, 'access')).toBe(false)
  now = 30 * 60 * 1000
  expect(grants.permits(identity, 'access')).toBe(false)
  grants.approve(identity, 'access')
  expect(grants.permits(identity, 'changed')).toBe(false)
  expect(grants.permits(identity, 'access')).toBe(false)
})

it('Shell 普通和自动模式共用风险规则，已发放的确认仍须复核', () => {
  const normal = { system: false, isolatedWorkspace: false, approvalPolicy: 'ask' as const, hasResolution: false }
  const dangerous = { risk: 'dangerous', needsConfirmation: true } as const
  const write = { risk: 'write', needsConfirmation: false } as const
  const safe = { risk: 'safe', needsConfirmation: false } as const
  expect(shellConfirmationMode(safe, normal)).toBe('execute')
  expect(shellConfirmationMode(write, { ...normal, isolatedWorkspace: true })).toBe('execute')
  expect(shellConfirmationMode(write, normal)).toBe('request')
  expect(shellConfirmationMode(dangerous, normal)).toBe('request')
  expect(shellConfirmationMode(dangerous, { ...normal, approvalPolicy: 'never' })).toBe('execute')
  expect(shellConfirmationMode(dangerous, { ...normal, hasResolution: true, approvalPolicy: 'never' })).toBe('verify')
  expect(shellConfirmationMode(safe, { ...normal, hasResolution: true })).toBe('stale')
})

it('共享父工作区按相同自动模式和操作风险决定挂载权限', async () => {
  const db = {} as Kysely<Database>
  const prepare = vi.fn(async () => ({ ok: true, value: { id: '合成确认' } }))
  const confirmation = { gate: { prepare } } as unknown as ReturnType<typeof createSqliteToolConfirmation>
  const execute = vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: '合成结果', stderr: '' }))
  platform.diagnostics.mockResolvedValue({ supported: true, methods: ['seatbelt'], checkAvailable: true })
  platform.createExecutor.mockResolvedValue({ id: 'seatbelt', capabilities: {
    filesystem: true, networkDeny: true, uiDeny: true, timeout: true, cancellation: true,
  }, execute })
  platform.command.mockImplementation((text: string) => text)
  let automaticMode = false
  let shellEnabled = true
  const workspace = await realpath(tmpdir())
  const tool = await createDesktopShellTool(db, confirmation, JSON.stringify,
    async () => ({ automaticMode, shellEnabled, dangerousEnabled: true }), async () => ({ path: workspace, identity: '合成目录身份' }))
  const scope: ToolScope = {
    identity: { ownerId: 'owner', sessionId: '2', runId: 'child' },
    roundId: 'round', signal: AbortSignal.timeout(5000), resolution: null,
    async execute() { throw new Error('不应执行宿主命令') },
  }
  const input = { command: 'echo sample > sample.txt' }
  const call = { id: 'call', name: 'shell', input }
  expect(await tool!.execute(input, scope, call)).toMatchObject({ kind: 'waiting' })
  expect(execute).not.toHaveBeenCalled()
  expect(prepare.mock.calls).toHaveLength(1)
  automaticMode = true
  expect(await tool!.execute(input, scope, call)).toMatchObject({ successful: true, mutated: true })
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: workspace, readonlyPaths: [], readwritePaths: [workspace] }),
    expect.any(AbortSignal), undefined)
  expect(await tool!.execute({ ...input, cwd: '..' }, scope, call)).toMatchObject({ executed: false })
  shellEnabled = false
  expect(await tool!.execute(input, scope, call)).toMatchObject({ executed: false })
  expect(execute).toHaveBeenCalledOnce()
  shellEnabled = true
  const read = { command: 'pwd' }
  expect(await tool!.execute(read, scope, { ...call, input: read })).toMatchObject({ successful: true, mutated: false })
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: workspace, readonlyPaths: [workspace], readwritePaths: [] }),
    expect.any(AbortSignal), undefined)
})

it.each([false, true])('自动模式为 %s 时按审批策略执行并逐项回报废纸篓结果', async automaticMode => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-trash-result-'))
  try {
    await Promise.all(['local.txt', 'external.txt'].map(name => writeFile(join(directory, name), '合成内容')))
    const db = { transaction: () => ({ execute: (callback: (tx: unknown) => unknown) => callback({}) }) } as unknown as Kysely<Database>
    const confirmation = {
      gate: { verify: vi.fn(async () => ({ ok: true, value: {} })) },
      claim: async () => true,
    } as unknown as ReturnType<typeof createSqliteToolConfirmation>
    const move = vi.fn(async (target: { path: string }) => {
      if (basename(target.path) === 'external.txt') throw new Error('合成系统拒绝')
    })
    platform.diagnostics.mockResolvedValue({ supported: false, methods: [], checkAvailable: true })
    const tool = await createDesktopShellTool(db, confirmation, JSON.stringify,
      async () => ({ automaticMode, shellEnabled: true, dangerousEnabled: false }), undefined, undefined, move)
    const input = { cwd: directory, command: 'rm -f local.txt external.txt' }
    const scope: ToolScope = {
      identity: { ownerId: 'owner', sessionId: '1', runId: 'run' },
      roundId: 'round', signal: AbortSignal.timeout(5000), resolution: automaticMode ? null : {} as NonNullable<ToolScope['resolution']>,
      async execute() { throw new Error('移入废纸篓不应调用普通 Shell 执行器') },
    }
    const result = await tool!.execute(input, scope, { id: 'call', name: 'shell', input })
    expect(confirmation.gate.verify).toHaveBeenCalledTimes(automaticMode ? 0 : 1)
    expect(move).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ kind: 'completed', successful: false, executed: true, mutated: true,
      value: { status: 'partial', movedToTrash: [expect.stringMatching(/local\.txt$/u)], failed: [expect.stringMatching(/external\.txt$/u)] } })
    if (result.kind !== 'completed') throw new Error('废纸篓操作尚未完成')
    const projected = formatToolResult('shell', JSON.stringify(result.value), true)
    expect(projected).toContain('（shell） · 部分成功')
    expect(projected).toContain('[已移入废纸篓]')
    expect(projected).toContain('[未移入废纸篓]')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('未绑定工作区且省略 cwd 时，自动模式可以将绝对路径目标移入废纸篓', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-trash-absolute-'))
  try {
    const root = await realpath(directory)
    const path = join(root, '探测文件.txt')
    const destination = join(root, '模拟废纸篓.txt')
    await writeFile(path, '合成内容')
    const move = vi.fn(async (target: { path: string }) => rename(target.path, destination))
    platform.diagnostics.mockResolvedValue({ supported: true, methods: ['seatbelt'] })
    const tool = await createDesktopShellTool({} as Kysely<Database>, {} as ReturnType<typeof createSqliteToolConfirmation>,
      JSON.stringify, async () => ({ automaticMode: true, shellEnabled: true, dangerousEnabled: false }),
      undefined, undefined, move)
    const scope: ToolScope = {
      identity: { ownerId: 'owner', sessionId: '1', runId: 'run' },
      roundId: 'round', signal: AbortSignal.timeout(5000), resolution: null,
      async execute() { throw new Error('移入废纸篓不应调用普通 Shell 执行器') },
    }
    const run = (command: string) => {
      const input = { command }
      return tool!.execute(input, scope, { id: 'call', name: 'shell', input })
    }
    expect(await run('rm ./探测文件.txt')).toMatchObject({ executed: false,
      value: { error: expect.stringContaining('临时目录') } })
    expect(move).not.toHaveBeenCalled()
    expect(await run(`rm -- '${path}'`)).toMatchObject({ successful: true, executed: true,
      value: { movedToTrash: [path] } })
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('合成内容')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
