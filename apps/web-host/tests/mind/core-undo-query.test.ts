import assert from 'node:assert/strict'
import test from 'node:test'
import { withUndoTransactionClient } from '../../src/modules/undo/service.js'
import type { UndoAdapterContext } from '@gugu/core/undo'

test('借用事务查询只允许限定语句且不能在作用域外使用', async () => {
  let calls = 0
  const tx = { async executeQuery() { calls++; return { rows: [] } } } as unknown as UndoAdapterContext['tx']
  let leaked: any
  await withUndoTransactionClient(tx, async client => {
    leaked = client
    for (const sql of ['COMMIT', 'SELECT 1; COMMIT', 'UPDATE projects SET name=$3 WHERE id=$1 AND user_id=$2; COMMIT', 'SELECT pg_advisory_unlock($1)', 'SELECT * FROM secrets WHERE id=$1 AND user_id=$2 FOR UPDATE', 'SELECT * FROM external_records WHERE id=$1 AND user_id=$2 FOR UPDATE']) {
      await assert.rejects(client.query(sql, [1, 2, 3]), /不允许/)
    }
    await client.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [1, 2])
    assert.equal(typeof client.release, 'undefined')
  })
  await assert.rejects(leaked.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [1, 2]), /已结束/)
  assert.equal(calls, 1)
})

test('借用事务排空未等待查询并拒绝并发', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tx = { async executeQuery() { await gate; return { rows: [] } } } as unknown as UndoAdapterContext['tx']
  let settled = false
  const execution = withUndoTransactionClient(tx, async client => {
    void client.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [1, 2])
    await assert.rejects(client.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2 FOR UPDATE', [1, 2]), /正在执行/)
  }).finally(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false)
  release()
  await assert.rejects(execution, /未等待/)
})
