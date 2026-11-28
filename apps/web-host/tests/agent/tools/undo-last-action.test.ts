import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createToolRegistry, createUndoLastActionTool } from '@gugu/core/tools'
import type { AgentDispatchLease } from '../../../src/modules/agent/run/dispatch.js'
import { createWebAgentUndoLastActionPort } from '../../../src/modules/agent/tools/undo.js'
import type { createHostCoreUndoOperations } from '../../../src/modules/undo/service.js'

test('undo_last_action 固定本次撤销目标，收据重放不重选下一条操作', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-undo-last-action-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    runtime = (await openSqliteRuntime(join(directory, 'core.db'))).runtime
    const identity = { ownerId: randomUUID(), sessionId: '41', runId: 'run-synthetic' }
    const undoContext = `agent:${identity.sessionId}:${identity.runId}`
    const lease = { identity, token: 'token-synthetic', fence: 9, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as AgentDispatchLease
    const targetId = randomUUID()
    await runtime.db.insertInto('undo_operations').values({
      id: targetId, user_id: identity.ownerId.replaceAll('-', ''), undo_context_id: undoContext, group_id: 'group-synthetic',
      resource: 'mind', action: 'create', target_refs: JSON.stringify([1]), before_state: JSON.stringify({}),
      after_state: JSON.stringify({}), base_versions: JSON.stringify({}), artifact_refs: JSON.stringify([]),
      actor_type: 'web', status: 'active', created_at: new Date().toISOString(), undone_at: null,
      expires_at: null, failure_code: null,
    }).execute()
    const projectId = randomUUID()
    let applies = 0
    const appliedIds: string[] = []
    const operations = {
      async apply(_owner: string, _context: string, operationId: string) {
        appliedIds.push(operationId)
        applies++
        const row = await runtime!.db.selectFrom('undo_operations').select('status').where('id', '=', operationId).executeTakeFirstOrThrow()
        await runtime!.db.updateTable('undo_operations').set({ status: 'undone' }).where('id', '=', operationId).execute()
        return { operation: { operation_id: operationId, status: 'undone' }, idempotent: row.status === 'undone', events: [] }
      },
    } as unknown as UndoOperations
    const port = createWebAgentUndoLastActionPort({ core: runtime, pool: { async query() { return { rowCount: 1, rows: [] } } } as never,
      lease, operations })
    const registry = createToolRegistry({ groups: [{ id: 'undo', name: '撤销', tools: [createUndoLastActionTool(port)] }],
      authorize: async (candidate, name) => candidate.ownerId === identity.ownerId && name === 'undo_last_action' })
    const dispatch = (id: string) => registry.tools.dispatch({ id, name: 'undo_last_action', input: {} }, {
      identity, roundId: 'round-synthetic', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('Undo must use the configured Node state machine') },
    })
    assert.deepEqual(await dispatch('undo-call'), {
      kind: 'completed', successful: true, mutated: true,
      value: { success: true, operation: { operation_id: targetId, status: 'undone' }, idempotent: false },
    })
    assert.deepEqual(await dispatch('undo-call'), {
      kind: 'completed', successful: true, mutated: false,
      value: { success: true, operation: { operation_id: targetId, status: 'undone' }, idempotent: false },
    })
    assert.equal(applies, 1)
    const noUndo = await dispatch('next-undo-call')
    assert.equal(noUndo.kind, 'completed')
    assert.equal(noUndo.successful, false)
    assert.equal((noUndo.value as { error?: string }).error, '当前运行没有可撤销的操作')
    await runtime.db.insertInto('undo_operations').values({
      id: projectId, user_id: identity.ownerId.replaceAll('-', ''), undo_context_id: undoContext, group_id: 'project-group',
      resource: 'projects', action: 'delete', target_refs: JSON.stringify([1]), before_state: JSON.stringify({}),
      after_state: JSON.stringify({}), base_versions: JSON.stringify({}), artifact_refs: JSON.stringify([]),
      actor_type: 'web', status: 'active', created_at: new Date(Date.now() + 1000).toISOString(), undone_at: null,
      expires_at: null, failure_code: null,
    }).execute()
    assert.deepEqual(await dispatch('project-undo-call'), {
      kind: 'completed', successful: true, mutated: true,
      value: { success: true, operation: { operation_id: projectId, status: 'undone' }, idempotent: false },
    })
    assert.equal(applies, 2, '项目撤销应进入 Main 已装配的 Node 项目 Undo 服务')
    assert.deepEqual(appliedIds, [targetId, projectId])
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

type UndoOperations = ReturnType<typeof createHostCoreUndoOperations>
