import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { recordForwardUndoOperation } from '../../../src/data/undo.js'
import { databaseTime, projectRecord } from '../../../src/data/codec.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createProjectDeleteTool } from '../../../src/agent/tools/projects/index.js'
import { createConfirmationGate, type ConfirmationIntent } from '../../../src/agent/tools/confirmation.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { InteractionResolution } from '../../../src/agent/models.js'
import type { ProjectDeleteRuntime } from '../../../src/agent/tools/projects/index.js'

it('批删在确认后共享一个事务和 Undo；级联目标变动时回滚，已提交的调用只重放结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-project-delete-'))
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime: core, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = dataContext(ownerId)
      const key = ownerId.replaceAll('-', '')
      const first = await core.transaction(owner, data => data.projects.create({ name: '合成项目甲' }))
      const second = await core.transaction(owner, data => data.projects.create({ name: '合成项目乙' }))
      const published: Array<number | undefined> = []
      let createCascadeDuringClaim = false
      let intent: ConfirmationIntent | undefined
      const gate = createConfirmationGate({
        now: () => 0,
        authorize: async binding => binding.ownerId === ownerId ? 'test-epoch' : null,
        async prepare(binding, snapshot) {
          intent = { schemaVersion: 2, binding, intentId: 'intent', interactionId: 'interaction', operationId: 'operation',
            purpose: 'action', action: 'delete_project', expiresAt: 60000, authorizationEpoch: 'test-epoch',
            targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest }
          return intent
        },
        async inspect() { return intent ?? null },
        async load() {
          if (!intent) return null
          return { intent, receipt: { schemaVersion: 2, binding: intent.binding, intentId: intent.intentId,
            interactionId: intent.interactionId, receiptId: 'approved', purpose: intent.purpose, action: intent.action,
            status: 'approved', expiresAt: intent.expiresAt } }
        },
      }, { purpose: 'action', action: 'delete_project' })

      const stamp = '2026-11-18 00:00:00.000000'
      const runtime: ProjectDeleteRuntime = {
        transactionPort(tx) {
          return {
            async getOwnedProject(user, id) {
              const row = await tx.selectFrom('projects').selectAll().where('user_id', '=', user.replaceAll('-', '')).where('id', '=', id).executeTakeFirst()
              return row ? projectRecord(row) : null
            },
            async listProjectResources(user, id) {
              const rows = await tx.selectFrom('calendar_events').selectAll().where('user_id', '=', user.replaceAll('-', ''))
                .where('project_id', '=', id).where('deleted_at', 'is', null).execute()
              return { files: [], folders: [], tasks: [], events: rows.map(row => ({ ...row, client: row.contact_name })) }
            },
            async updateProject(user, id, fields) {
              const row = await tx.updateTable('projects').set({ ...fields, deleted_at: databaseTime(fields.deleted_at!, 'sqlite') })
                .where('user_id', '=', user.replaceAll('-', '')).where('id', '=', id).returningAll().executeTakeFirstOrThrow()
              return projectRecord(row)
            },
            async updateEvent() { throw new Error('测试仅允许无并发新增事件的删除') },
            async updateFile() { throw new Error('测试没有文件') },
            async updateFolder() { throw new Error('测试没有目录') },
            async updateTask() { throw new Error('测试没有提醒') },
            async recordUndo(record) {
              await recordForwardUndoOperation(tx, 'sqlite', record)
            },
          }
        },
        storage: { async moveToTrash() { throw new Error('测试没有文件') } },
        async withJournal(_owner, _operation, work) {
          return work({ async record() { throw new Error('测试无需移动文件') }, async finish() {} })
        },
        async recoverJournal() {},
        async publish(event) { published.push(event.entityId) },
      }
      const tool = createProjectDeleteTool(core, runtime, {
        gate,
        async claim(tx) {
          if (createCascadeDuringClaim) {
            await tx.insertInto('calendar_events').values({ user_id: key, title: '并发新增活动',
              date: '2099-12-01', type: 'event', project_id: second.id, version: 1, created_at: stamp, deleted_at: null }).execute()
          }
          return true
        },
      })
      const registry = createToolRegistry({ authorize: async identity => identity.ownerId === ownerId, tools: [tool] })
      const confirmed: InteractionResolution = { interactionId: 'interaction', receiptId: 'approved', status: 'confirmed', value: null }
      const args = { project_ids: [second.id, first.id] }
      const dispatch = (id: string, resolution: InteractionResolution | null = null) => registry.tools.dispatch(
        { id, name: 'delete_project', input: args },
        { identity: { ownerId, sessionId: '4', runId: 'synthetic-run' }, roundId: '1', resolution, signal: new AbortController().signal,
          async execute() { throw new Error('不执行沙盒') } },
      )
      const live = () => core.transaction(owner, db => db.projects.list(false))
      expect((await dispatch('stale')).kind).toBe('waiting')
      expect(await live()).toHaveLength(2)
      createCascadeDuringClaim = true
      expect(await dispatch('stale', confirmed)).toMatchObject({ successful: false })
      expect(await core.db.selectFrom('calendar_events').select('id').execute()).toEqual([])
      expect(await live()).toHaveLength(2)
      expect(await core.db.selectFrom('undo_operations').select('id').execute()).toEqual([])
      expect(published).toEqual([])
      createCascadeDuringClaim = false
      expect((await dispatch('batch')).kind).toBe('waiting')
      expect(await dispatch('batch', confirmed)).toMatchObject({ successful: true, mutated: true, value: { success: true,
        deleted_count: 2, results: [{ deleted_project_id: first.id, file_count: 0 }, { deleted_project_id: second.id, file_count: 0 }] } })
      expect(await live()).toHaveLength(0)
      const undo = await core.db.selectFrom('undo_operations').select('target_refs').execute()
      expect(undo.map(row => JSON.parse(String(row.target_refs))))
        .toEqual([[{ kind: 'project', id: first.id }, { kind: 'project', id: second.id }]])
      expect(await dispatch('batch', confirmed)).toMatchObject({ successful: true, mutated: false })
      expect(published).toEqual([first.id, second.id])
    } finally { await core.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
