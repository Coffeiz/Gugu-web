import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import type { TrashPurgeConfirmation } from '@gugu/core/tools'
import { createAgentTrashPurgePort } from '../../src/modules/agent-sessions/tools/agent-trash-tool.js'
import type { AgentDispatchLease } from '../../src/modules/agent-sessions/persistence/agent-run-dispatch-postgres.js'
import type { AgentTrashPurgeOperations } from '../../src/modules/files/trash.js'

test('Agent permanent_delete 复核 owner lease 与目标快照，确认后只创建一次持久 Node purge job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-trash-purge-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    runtime = (await openSqliteRuntime(join(directory, 'core.db'))).runtime
    const identity = { ownerId: randomUUID(), sessionId: '71', runId: 'run-trash-purge' }
    const lease = { identity, token: 'lease-token', fence: 4, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as AgentDispatchLease
    let claims = 0, queued = 0, submissions = 0
    const jobs = new Map<string, { id: number; status: 'queued'; progressCurrent: number; progressTotal: number; failedCount: number; errorCode: null }>()
    const pool = { async query(sql: string) {
      if (sql.includes('conversation_sessions')) return { rowCount: 1, rows: [{}] }
      if (sql.includes('SELECT count(*)') && sql.includes('FROM (SELECT file.id')) return { rowCount: 1, rows: [{ count: 2, digest: 'files-digest' }] }
      if (sql.includes('SELECT count(*)') && sql.includes('FROM (SELECT folder.id')) return { rowCount: 1, rows: [{ count: 1, digest: 'folders-digest' }] }
      assert.fail(`unexpected query: ${sql}`)
    } } as never
    const operations = {
      async startEmptyForAgent(ownerId: string, operationId: string, snapshot: { file_count: number; folder_count: number; digest: string }) {
        assert.equal(ownerId, identity.ownerId)
        assert.deepEqual(snapshot, { file_count: 2, folder_count: 1, digest: createHash('sha256').update('files-digest:folders-digest').digest('hex') })
        submissions++
        if (submissions === 1) throw new Error('预留已提交，首次任务提交前进程中断')
        const current = jobs.get(operationId)
        if (current) return current
        const created = { id: 91, status: 'queued' as const, progressCurrent: 0, progressTotal: 3, failedCount: 0, errorCode: null }
        jobs.set(operationId, created); queued++
        return created
      },
      async getAgentEmpty(ownerId: string, operationId: string) {
        assert.equal(ownerId, identity.ownerId)
        return jobs.get(operationId) ?? null
      },
    } satisfies AgentTrashPurgeOperations
    const confirmation = { gate: {} as never, async claim(_tx, receipt, signal) {
      signal.throwIfAborted(); assert.equal(receipt.action, 'permanent_delete'); claims++; return true
    } } as TrashPurgeConfirmation
    const port = createAgentTrashPurgePort({ core: runtime, pool, lease, operations, confirmation })
    const snapshot = await port.preview(identity, new AbortController().signal)
    const request = { identity, roundId: 'round-1', toolCallId: 'purge-1', snapshot,
      confirmation: { action: 'permanent_delete' } as never, signal: new AbortController().signal }
    assert.deepEqual(await port.apply(request), { kind: 'completed', successful: true, mutated: true,
      value: { success: true, job_id: 91, status: 'queued', progress_current: 0, progress_total: 3, failed_count: 0, error_code: null } })
    assert.deepEqual(await port.apply(request), { kind: 'completed', successful: true, mutated: false,
      value: { success: true, job_id: 91, status: 'queued', progress_current: 0, progress_total: 3, failed_count: 0, error_code: null } })
    assert.equal(queued, 1)
    assert.equal(submissions, 2, '确认预留之后首次任务提交中断时，恢复应以同一操作 ID 安全重试')
    assert.equal(claims, 1)
    await assert.rejects(port.preview({ ...identity, ownerId: randomUUID() }, new AbortController().signal), /授权已失效/)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
