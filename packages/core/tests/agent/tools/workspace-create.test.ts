import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceTool, type WorkspaceCreatePort } from '../../../src/agent/tools/workspaces.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '8', runId: 'create-workspace-run' }
const scope = { identity, roundId: 'round-1', signal: new AbortController().signal, resolution: null,
  execute: async () => { throw new Error('工作区工具不得执行宿主进程') } }
const port: WorkspaceCreatePort = { create: vi.fn(async input => ({ kind: 'completed' as const, successful: true, mutated: true, value: { success: true, workspace: {
  workspace_id: 31, name: input.args.workspace_name.trim(), kind: input.args.kind,
  project_id: input.args.project_id ?? null,
} } })), reconcile: vi.fn(async () => ({ kind: 'unknown' as const })) }
const registry = createToolRegistry({ groups: [{ id: 'workspaces', name: '工作区', tools: [createWorkspaceTool(port)] }], authorize: async () => true })
const call = (input: unknown, id = 'create') => registry.tools.dispatch({ id, name: 'create_workspace', input }, scope)

afterEach(() => vi.clearAllMocks())

it('通过注册器把 project/directory 目标与 enabled 原样交给共享 Host 端口', async () => {
  for (const [index, input] of [
    { workspace_name: ' 项目窗口 ', kind: 'project', project_id: 17, enabled: false },
    { workspace_name: '顶层目录', kind: 'directory' },
  ].entries()) {
    expect(await call(input, `create-${index}`)).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { success: true } })
  }
  expect(port.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ identity, args: { workspace_name: ' 项目窗口 ', kind: 'project', project_id: 17, enabled: false } }))
  expect(port.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ args: { workspace_name: '顶层目录', kind: 'directory' } }))
})

it('透传 round 与 call 身份并将 reconcile 委托给 Host 持久回执端口', async () => {
  await call({ workspace_name: '目录', kind: 'directory' }, 'recover-me')
  expect(port.create).toHaveBeenCalledWith(expect.objectContaining({ roundId: 'round-1', toolCallId: 'recover-me' }))
  expect(await registry.tools.reconcile({ id: 'recover-me', name: 'create_workspace', input: { workspace_name: '目录', kind: 'directory' } }, { ...identity, roundId: 'round-1' }))
    .toEqual({ kind: 'unknown' })
  expect(port.reconcile).toHaveBeenCalledWith(expect.objectContaining({ roundId: 'round-1', toolCallId: 'recover-me' }))
})

it('拒绝混用和缺失资源 ID，避免把工作区 ID 当成项目或目录 ID', async () => {
  expect(await call({ workspace_name: '窗口', kind: 'project', project_id: 0 }, 'zero-project')).toMatchObject({ successful: false })
  expect(await call({ workspace_name: '窗口', kind: 'project', project_id: -1 }, 'negative-project')).toMatchObject({ successful: false })
  expect(await call({ workspace_name: '窗口', kind: 'directory', project_id: 17 }, 'directory-mix')).toMatchObject({ successful: false })
  expect(await call({ workspace_name: '   ', kind: 'directory' }, 'blank')).toMatchObject({ successful: false })
  expect(port.create).not.toHaveBeenCalled()
})
