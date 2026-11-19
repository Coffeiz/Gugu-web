import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { WorkspaceDirectoryDeleteRequest, WorkspaceUnlinkConfirmation } from '@gugu/core/tools'
import { createWebAgentWorkspaceDirectoryDeletePort } from '../../src/modules/agent/tools/workspaces/delete.js'
import type { AgentDispatchLease } from '../../src/modules/agent/run/dispatch.js'
import type { WorkspaceDirectoryOperations } from '../../src/modules/workspaces/routes.js'

test('工作区物理删除在同一Web lease下只执行一次，收据可恢复且不重复移除目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-workspace-directory-delete-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    runtime = (await openSqliteRuntime(join(directory, 'core.db'))).runtime
    const identity = { ownerId: randomUUID(), sessionId: '41', runId: 'run-synthetic' }
    const lease = { identity, token: 'token-synthetic', fence: 9, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as AgentDispatchLease
    let claims = 0, deletions = 0, resultLostAfterDelete = false
    const confirmation: WorkspaceUnlinkConfirmation = { gate: {} as never, async claim() { claims++; return true } }
    const preview = { id: 9, name: '临时目录', directory_name: 'fixed-segment', is_default: false, is_system: false,
      file_count: 2, folder_count: 1, bound_session_count: 3, bound_task_count: 1 }
    const operations = {
      async previewDelete() { return preview },
      async delete(_owner: string, _id: number, expected?: typeof preview) {
        assert.deepEqual(expected, preview)
        deletions++
        if (resultLostAfterDelete) throw new Error('模拟删除完成后进程退出，结果收据尚未写入')
        return { ok: true as const, workspaceDirectoryId: preview.id }
      },
    } as WorkspaceDirectoryOperations
    const port = createWebAgentWorkspaceDirectoryDeletePort({ core: runtime, pool: { async query() { return { rowCount: 1, rows: [] } } } as never,
      lease, operations, confirmation })
    assert.deepEqual(await port.preview(identity, preview.id, new AbortController().signal), preview)
    const request: WorkspaceDirectoryDeleteRequest & { confirmation: never; signal: AbortSignal } = {
      identity, roundId: 'round-synthetic', toolCallId: 'delete-call', directoryId: preview.id, preview,
      confirmation: { action: 'delete_workspace_directory' } as never, signal: new AbortController().signal,
    }
    assert.deepEqual(await port.apply(request), {
      kind: 'completed', successful: true, mutated: true,
      value: { success: true, deleted_directory_id: preview.id, name: preview.name },
    })
    assert.deepEqual(await port.apply(request), {
      kind: 'completed', successful: true, mutated: false,
      value: { success: true, deleted_directory_id: preview.id, name: preview.name },
    })
    assert.equal(deletions, 1)
    assert.equal(claims, 1)

    resultLostAfterDelete = true
    const uncertain = { ...request, toolCallId: 'uncertain-delete-call' }
    assert.deepEqual(await port.apply(uncertain), { kind: 'unknown' })
    assert.deepEqual(await port.apply(uncertain), { kind: 'unknown' })
    assert.equal(deletions, 2, '持久预留已存在时不得重放物理删除')
    assert.equal(claims, 2)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
