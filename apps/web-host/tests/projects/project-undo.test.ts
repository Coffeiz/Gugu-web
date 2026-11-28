import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { applyProjectUndo, type ProjectUndoStorage } from '../../src/modules/undo/adapters/projects.js'

test('项目摘要更新撤销与重做恢复各自的摘要值', async () => {
  let value: unknown = '新摘要'
  const client = { async query(sql: string, params?: unknown[]) {
    if (sql.startsWith('SELECT')) return { rows: [{ id: 1, name: '项目', version: 2 }] }
    if (sql.startsWith('UPDATE projects')) {
      const position = /summary=\$(\d+)/.exec(sql)
      assert.ok(position)
      value = params![Number(position[1]) - 1]
      return { rows: [{ version: 3 }] }
    }
    return { rows: [] }
  } } as unknown as PoolClient
  const storage: ProjectUndoStorage = { renameDirectory: async () => {}, trash: {
    async moveToTrash() { throw new Error('不应移动文件') },
    async restoreFromTrash() { throw new Error('不应恢复文件') },
  } }
  const operation = { id: 'op', action: 'update', before_state: { items: { 'project:1': { name: '项目', summary: '旧摘要' } } }, after_state: { items: { 'project:1': { name: '项目', summary: '新摘要', version: 2 } }, undo_versions: { 'project:1': 2 } } }
  await applyProjectUndo(client, 'owner', operation, 'undo', storage, [])
  assert.equal(value, '旧摘要')
  await applyProjectUndo(client, 'owner', operation, 'redo', storage, [])
  assert.equal(value, '新摘要')
})

test('项目改名撤销保留目录反向补偿并更新项目文件路径', async () => {
  const moves: string[] = [], calls: string[] = []
  const client = { async query(sql: string) {
    calls.push(sql)
    if (sql.startsWith('SELECT')) return { rows: [{ id: 1, name: '新', start_date: '2026-01-01', version: 2 }] }
    return { rows: [{ version: 3 }] }
  } } as unknown as PoolClient
  const storage = { renameDirectory: async (_owner: string, oldKey: string, newKey: string) => { moves.push(`${oldKey} -> ${newKey}`) }, trash: {} } as ProjectUndoStorage
  const rollback: Array<() => Promise<void>> = []
  const result = await applyProjectUndo(client, 'owner', { id: 'op', action: 'update', before_state: { items: { 'project:1': { name: '旧', stages: [] } } }, after_state: { items: { 'project:1': { version: 2, name: '新' } } } }, 'undo', storage, rollback)
  assert.equal(result.versions['project:1'], 3)
  assert.ok(calls.some(sql => sql.startsWith('UPDATE files SET path=')))
  assert.match(moves[0]!, /新 #1 -> .*旧 #1/)
  await rollback[0]!()
  assert.match(moves[1]!, /旧 #1 -> .*新 #1/)
})

test('项目版本冲突时不搬移文件', async () => {
  let moved = false
  const client = { async query() { return { rows: [{ version: 5 }] } } } as unknown as PoolClient
  const storage: ProjectUndoStorage = { renameDirectory: async () => { moved = true }, trash: {
    async moveToTrash() { throw new Error('不应移动文件') },
    async restoreFromTrash() { throw new Error('不应恢复文件') },
  } }
  await assert.rejects(() => applyProjectUndo(client, 'owner', { id: 'op', action: 'update', before_state: {}, after_state: { items: { 'project:1': { version: 2 } } } }, 'undo', storage, []))
  assert.equal(moved, false)
})
