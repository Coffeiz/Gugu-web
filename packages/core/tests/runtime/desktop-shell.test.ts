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
  const workspace = tmpdir()
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
  expect(await tool!.execute({ ...input, cwd: workspace }, scope, call)).toMatchObject({ executed: false })
  shellEnabled = false
  expect(await tool!.execute(input, scope, call)).toMatchObject({ executed: false })
  expect(execute).toHaveBeenCalledOnce()
  shellEnabled = true
  const read = { command: 'pwd' }
  expect(await tool!.execute(read, scope, { ...call, input: read })).toMatchObject({ successful: true, mutated: false })
  expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: workspace, readonlyPaths: [workspace], readwritePaths: [] }),
    expect.any(AbortSignal), undefined)
})
