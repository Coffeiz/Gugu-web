import assert from 'node:assert/strict'
import test from 'node:test'
import { getAgentRagJieba } from '../../src/domains/agent-sessions/tools/agent-rag-jieba.js'

test('Host 装配 1.7.7 同版 Jieba 词典与 HMM=false 词项边界', () => {
  const jieba = getAgentRagJieba()
  assert.deepEqual(jieba.cut('群消息分词测试', false), ['群', '消息', '分词', '测试'])
  assert.equal(getAgentRagJieba(), jieba)
})
