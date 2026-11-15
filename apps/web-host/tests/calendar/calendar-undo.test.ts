import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PoolClient } from 'pg'
import { applyCalendarUndo } from '../../src/domains/undo/persistence/calendar.js'

test('事件及提醒先完成版本检查，再恢复字段并返回提交后事件', async () => {
  const calls: string[] = []
  const client = { async query(sql: string) {
    calls.push(sql)
    if (sql.startsWith('SELECT') && sql.includes('calendar_events')) return { rows: [{ id: 1, version: 2 }] }
    if (sql.startsWith('SELECT')) return { rows: [{ id: 2, enabled: true }] }
    if (sql.includes('RETURNING version')) return { rows: [{ version: 3 }] }
    return { rows: [] }
  } } as unknown as PoolClient
  const result = await applyCalendarUndo(client, 'owner', {
    id: 'op', action: 'update',
    before_state: { items: { 'event:1': { title: '旧' }, 'task:2': { cron: '@once:old' } } },
    after_state: { items: { 'event:1': { version: 2, title: '新' }, 'task:2': { cron: '@once:new' } } },
  }, 'undo')
  assert.deepEqual(result.versions, { 'event:1': 3, 'task:2': 0 })
  assert.deepEqual(result.events.map(event => event.resource), ['calendar', 'scheduled_tasks'])
  assert.ok(calls.slice(0, 2).every(sql => sql.startsWith('SELECT')))
})

test('事件版本冲突时不会修改事件或提醒', async () => {
  const calls: string[] = []
  const client = { async query(sql: string) { calls.push(sql); return { rows: [{ version: 4 }] } } } as unknown as PoolClient
  await assert.rejects(() => applyCalendarUndo(client, 'owner', { id: 'op', action: 'delete', before_state: {}, after_state: { items: { 'event:1': { version: 2 } } } }, 'undo'))
  assert.equal(calls.length, 1)
})

test('创建和删除的撤销分别软删除或恢复事件并切换提醒', async () => {
  for (const action of ['create', 'delete'] as const) {
    const writes: Array<{ sql: string, values: unknown[] }> = []
    const client = { async query(sql: string, values: unknown[]) {
      if (sql.startsWith('SELECT') && sql.includes('calendar_events')) return { rows: [{ version: 1 }] }
      if (sql.startsWith('SELECT')) return { rows: [{ enabled: false }] }
      writes.push({ sql, values })
      return { rows: [{ version: 2 }] }
    } } as unknown as PoolClient
    const result = await applyCalendarUndo(client, 'owner', { id: 'op', action,
      before_state: { items: { 'task:2': { enabled: true } } },
      after_state: { items: { 'event:1': { version: 1 }, 'task:2': { enabled: false } } },
    }, 'undo')
    assert.equal(writes[0]!.values[2] === null, action === 'delete')
    assert.equal(writes[1]!.values[2], action === 'delete')
    assert.equal(result.events[0]!.operation, action === 'create' ? 'delete' : 'create')
  }
})
