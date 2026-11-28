import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { createScheduledTaskDeleteTool } from '../../../src/agent/tools/scheduled-tasks/index.js'
import { createConfirmationGate, type ConfirmationIntent } from '../../../src/agent/tools/confirmation.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { InteractionResolution } from '../../../src/agent/models.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'

it('确认只绑定 owner 的独立任务；目标变化回滚 claim，批准后批删并重放原收据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-delete-tasks-'))
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime: core, ownerId } = await openSqliteRuntime(path)
    try {
      const dbOwner = ownerId.replaceAll('-', '')
      const other = randomUUID().replaceAll('-', '')
      const identity = { ownerId, sessionId: '4', runId: 'synthetic-run' }
      const stamp = '2026-11-18 00:00:00.000000'
      await sql`INSERT INTO calendar_events(id,user_id,title,date,type,version,created_at)
        VALUES(1,${dbOwner},'活动','2099-11-18','event',1,${stamp})`.execute(core.db)
      for (const [id, owner, eventId, name] of [[1, dbOwner, null, '任务甲'], [2, dbOwner, null, '任务乙'],
        [3, other, null, '他人任务'], [4, dbOwner, 1, '活动提醒']] as const) {
        await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,channels,enabled,created_at,updated_at)
          VALUES(${id},${owner},${eventId},${name},'合成指令','@once:2099-11-18T00:00:00+00:00','once','web',1,${stamp},${stamp})`.execute(core.db)
      }
      let intent: ConfirmationIntent | undefined
      let changeDuringClaim = false
      let claims = 0
      const gate = createConfirmationGate({
        now: () => 0,
        authorize: async binding => binding.ownerId === ownerId ? 'test-epoch' : null,
        async prepare(binding, snapshot) {
          intent = { schemaVersion: 2, binding, intentId: 'intent', interactionId: 'interaction', operationId: 'operation',
            purpose: 'action', action: 'delete_scheduled_task', expiresAt: 60000, authorizationEpoch: 'test-epoch',
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
      }, { purpose: 'action', action: 'delete_scheduled_task' })
      const published: number[] = []
      const registry = createToolRegistry({
        authorize: async candidate => candidate.ownerId === ownerId,
        tools: [createScheduledTaskDeleteTool(core, {
          gate,
          async claim(tx) {
            claims++
            if (changeDuringClaim) {
              await tx.updateTable('scheduled_tasks').set({ updated_at: '2026-11-19 00:00:00.000000' }).where('id', '=', 2).execute()
            }
            return true
          },
        }, async (_, id) => { published.push(id) })],
      })
      const confirmed: InteractionResolution = { interactionId: 'interaction', receiptId: 'approved', status: 'confirmed', value: null }
      const dispatch = (id: string, input: unknown, resolution: InteractionResolution | null = null) => registry.tools.dispatch({
        id, name: 'delete_scheduled_task', input,
      }, { identity, roundId: '1', resolution, signal: new AbortController().signal,
        async execute() { throw new Error('不执行沙盒') } })
      const taskIds = async () => (await core.db.selectFrom('scheduled_tasks').select('id').orderBy('id').execute()).map(row => row.id)
      expect(await dispatch('foreign', { task_id: 3 })).toMatchObject({ successful: false })
      expect(await dispatch('reminder', { task_id: 4 })).toMatchObject({ successful: false })
      expect(await dispatch('ambiguous', { task: '任务' })).toMatchObject({ successful: false, value: { candidates: [{ id: 1 }, { id: 2 }] } })
      const batch = { task_ids: [2, 1] }
      expect((await dispatch('stale', batch)).kind).toBe('waiting')
      expect(await taskIds()).toEqual([1, 2, 3, 4])
      changeDuringClaim = true
      expect(await dispatch('stale', batch, confirmed)).toMatchObject({ successful: false, mutated: false })
      expect((await core.db.selectFrom('scheduled_tasks').select('updated_at').where('id', '=', 2).executeTakeFirst())?.updated_at).toBe(stamp)
      expect(await taskIds()).toEqual([1, 2, 3, 4])
      expect(published).toEqual([])
      changeDuringClaim = false
      expect((await dispatch('batch', batch)).kind).toBe('waiting')
      const deleted = await dispatch('batch', batch, confirmed)
      expect(deleted).toMatchObject({ successful: true, mutated: true, value: { success: true, deleted_count: 2,
        results: [{ deleted_task_id: 1, name: '任务甲' }, { deleted_task_id: 2, name: '任务乙' }] } })
      expect(await taskIds()).toEqual([3, 4])
      expect(await dispatch('batch', batch, confirmed)).toMatchObject({ successful: true, mutated: false })
      expect(published).toEqual([1, 2])
      expect(claims).toBe(2)
    } finally { await core.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
