import assert from 'node:assert/strict'
import test from 'node:test'
import { targetConfirmationIdentity } from '../../src/domains/agent-sessions/tools/confirmation-identity.js'

test('目标重排不改变身份，但 action、上下文和目标变化会改变身份', () => {
  const original = targetConfirmationIdentity(
    'delete_scheduled_task',
    { task_id: [12, 4] },
    { scope: 'user_sandbox' },
  )

  assert.equal(original, 'target:{"action":"delete_scheduled_task","context":{"scope":"user_sandbox"},"targets":{"task_id":[{"type":"int","value":12},{"type":"int","value":4}]}}')
  assert.equal(
    targetConfirmationIdentity('delete_scheduled_task', { task_id: [4, 12] }, { scope: 'user_sandbox' }),
    original,
  )
  assert.notEqual(targetConfirmationIdentity('delete_other', { task_id: [4, 12] }, { scope: 'user_sandbox' }), original)
  assert.notEqual(targetConfirmationIdentity('delete_scheduled_task', { task_id: [4, 13] }, { scope: 'user_sandbox' }), original)
  assert.notEqual(targetConfirmationIdentity('delete_scheduled_task', { task_id: [4, 12] }, { scope: 'workspace' }), original)
})

test('目标身份保留字符串与整数类型，并按 Python code point 排序 Unicode 目标', () => {
  const identity = targetConfirmationIdentity('删除', { item: ['😀', '\uE000', '1', 1, 9007199254740993n] })

  assert.equal(
    identity,
    'target:{"action":"删除","context":{},"targets":{"item":[{"type":"int","value":1},{"type":"int","value":9007199254740993},{"type":"str","value":"1"},{"type":"str","value":""},{"type":"str","value":"😀"}]}}',
  )
})

test('目标身份拒绝空 action、空目标组、重复目标和非字符串/整数 ID', () => {
  assert.throws(() => targetConfirmationIdentity('  ', { id: [1] }))
  assert.throws(() => targetConfirmationIdentity('delete', {}))
  assert.throws(() => targetConfirmationIdentity('delete', { id: [] }))
  assert.throws(() => targetConfirmationIdentity('delete', { id: [1, 1] }))
  assert.throws(() => targetConfirmationIdentity('delete', { id: [true] } as never))
  assert.throws(() => targetConfirmationIdentity('delete', { id: [1.5] } as never))
  assert.throws(() => targetConfirmationIdentity('delete', { id: [Number.MAX_SAFE_INTEGER + 1] } as never))
  assert.throws(() => targetConfirmationIdentity('delete', { id: ['  '] }))
})
