import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleAttentionUnits } from '../../../src/im/attention/visible-units.js'

test('引用和行内代码不作为提问事实，偏移以 Unicode 码点计', () => {
  const input = '😀请问？\n> 引用问题？\n代码 `secret`。下一句！'
  const result = visibleAttentionUnits(input)
  assert.deepEqual(result.units, [
    { text: '😀请问？', start: 0, end: 4, terminator: '？' },
    { text: '代码', start: 13, end: 15, terminator: '。' },
    { text: '下一句', start: 25, end: 28, terminator: '！' },
  ])
  assert.equal(result.uncertain, false)
  assert.equal(result.visiblePrefix.at(-1), 11)
})

test('未闭合代码围栏标记为不确定且不暴露围栏正文', () => {
  const result = visibleAttentionUnits('前文。\n```\n秘密问题？')
  assert.equal(result.uncertain, true)
  assert.ok(result.units.every(unit => !unit.text.includes('秘密问题')))
})
