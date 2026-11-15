import assert from 'node:assert/strict'
import test from 'node:test'
import { questionEvidence } from '../../../src/im/attention/question.js'

test('疑问语素、转述与否定劝告使用相同判断', () => {
  assert.deepEqual(questionEvidence('为什么延期？'), [1, false])
  assert.deepEqual(questionEvidence('我想知道什么时候发布'), [1, true])
  assert.deepEqual(questionEvidence('他说为什么延期？'), [0, false])
  assert.deepEqual(questionEvidence('不要出来玩了吧？'), [0, false])
  assert.deepEqual(questionEvidence('这也行？'), [0.85, false])
  assert.deepEqual(questionEvidence('他哪会翻跟斗'), [0, false])
})
