import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectImChoiceButtons } from '../src/runtime/delivery/prompt.ts'

test('共享投影保留权限确认和自定义回复的有效动作', () => {
  const options = [
    { id: 'approve', label: '允许', token: 'synthetic-approve' },
    { id: 'expired', label: '已失效', token: '' },
    { id: '__custom_reply__', label: '自定义回复', token: 'synthetic-custom' },
  ]
  assert.deepEqual(projectImChoiceButtons({ kind: 'confirm', options })?.options, [options[0], options[2]])
  assert.match(projectImChoiceButtons({ kind: 'choice', body: '示例', options }, true).body, /点击「自定义回复」后发送文字/)
  assert.equal(projectImChoiceButtons({ kind: 'confirm', options, resolved: true }), null)
  assert.equal(projectImChoiceButtons({ kind: 'confirm', options, secret_fields: [{}] }), null)
  assert.equal(projectImChoiceButtons({ kind: 'choice', options, selection_mode: 'multiple' }), null)
})
