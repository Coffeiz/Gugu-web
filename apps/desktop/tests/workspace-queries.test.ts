import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from '../../../packages/core/node_modules/kysely/dist/index.js'
import { createAgentWorkspaceQueries } from '@gugu/core/workspaces'
import { initializeSqlite, openSqliteRuntime } from '../../../packages/core/src/data/sqlite.js'
import { createDesktopAgentSession, manageDesktopSessionWorkspace } from '../../../packages/core/src/agent/sessions/desktop.js'
import { createDesktopWorkspaceReadPort } from '../src/main/agent/workspace-queries.js'

const owner = '4f006172-79c5-4c28-9697-d8e65c7fe667'
const directories = [
  { id: 'personal', name: '个人文件' },
  { id: 'desktop:11111111-1111-4111-8111-111111111111', name: '合成工作区' },
]

it('工作区 Agent 查询复用桌面文件目录登记并过滤个人文件根', async () => {
  const hostRequest = vi.fn(async () => directories)
  const queries = createAgentWorkspaceQueries(createDesktopWorkspaceReadPort(hostRequest))

  await expect(queries.list(owner)).resolves.toEqual([{
    workspace_id: directories[1]!.id,
    name: '合成工作区',
    kind: 'directory',
    project_id: null,
    directory_id: directories[1]!.id,
    directory_name: '合成工作区',
  }])
  await expect(queries.get(owner, directories[1]!.id)).resolves.toMatchObject({
    workspace_id: directories[1]!.id,
    directory_id: directories[1]!.id,
  })
  await expect(queries.get(owner, 'desktop:22222222-2222-4222-8222-222222222222')).resolves.toBeNull()
  expect(hostRequest).toHaveBeenCalledWith('agent.files.workspaceList', {}, undefined)
})

it('工作区工具保留本机路径 IR 和不可用状态', async () => {
  const location = { kind: 'host_absolute', value: '/合成目录/资料' }
  const queries = createAgentWorkspaceQueries(createDesktopWorkspaceReadPort(async () => [
    { ...directories[1], available: true, location },
    { id: 'desktop:22222222-2222-4222-8222-222222222222', name: '离线目录', available: false },
  ]))
  await expect(queries.list(owner)).resolves.toMatchObject([
    { available: true, location },
    { available: false },
  ])
})

it('工作区 Agent 查询拒绝未通过文件服务校验的登记结果', async () => {
  const queries = createAgentWorkspaceQueries(createDesktopWorkspaceReadPort(async () => [
    { id: 'desktop:../outside', name: '合成无效目录' },
  ]))

  await expect(queries.list(owner)).rejects.toMatchObject({ code: 'storage_error' })
})

it('桌面会话绑定持久化目录身份、可读取和解除，且拒绝跨 owner 或群聊绑定', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-workspace-binding-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  try {
    const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
    const available = [directories[1]!]
    const list = () => Promise.resolve(available)
    await manageDesktopSessionWorkspace(runtime.db, ownerId, session.id, 'bind', available[0]!.id, list)
    await expect(manageDesktopSessionWorkspace(runtime.db, ownerId, session.id, 'show', undefined, list)).resolves.toMatchObject({
      workspace: { workspace_id: available[0]!.id, workspace_name: available[0]!.name, directory_id: available[0]!.id },
    })
    const user = ownerId.replaceAll('-', '')
    const persisted = await sql<{ session_context: string; context_epoch: number }>`SELECT session_context,context_epoch
      FROM conversation_sessions WHERE id=${session.id} AND user_id=${user}`.execute(runtime.db)
    expect(JSON.parse(persisted.rows[0]!.session_context).workspace_binding.directory_id).toBe(available[0]!.id)
    expect(persisted.rows[0]!.context_epoch).toBe(1)
    await expect(manageDesktopSessionWorkspace(runtime.db, owner, session.id, 'show', undefined, list))
      .rejects.toMatchObject({ code: 'not_found' })

    await manageDesktopSessionWorkspace(runtime.db, ownerId, session.id, 'unlink', undefined, list)
    await expect(manageDesktopSessionWorkspace(runtime.db, ownerId, session.id, 'show', undefined, list))
      .resolves.toEqual({ workspace: null })
    await sql`UPDATE conversation_sessions SET chat_type='group' WHERE user_id=${user} AND id=${session.id}`.execute(runtime.db)
    await expect(manageDesktopSessionWorkspace(runtime.db, ownerId, session.id, 'bind', available[0]!.id, list))
      .rejects.toMatchObject({ code: 'invalid_request' })
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
