import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRagJieba, tokenizeRaw } from '../../../../packages/core/src/agent/rag/tokenizer.js'
import { getAgentRagJieba } from '../../src/modules/agent-sessions/tools/agent-rag-jieba.js'

type GoldenCase = { text: string; tokens: string[] }

test('Host 装配 1.7.7 同版 Jieba 词典与 HMM=false 词项边界', () => {
  const jieba = getAgentRagJieba()
  assert.deepEqual(jieba.cut('群消息分词测试', false), ['群', '消息', '分词', '测试'])
  assert.equal(getAgentRagJieba(), jieba)
})

test('Host 正式 Jieba 经 Core tokenizer 保持 1.7.7 固定语料词项', async () => {
  const jieba = getAgentRagJieba()
  configureRagJieba(jieba)
  const fixtureUrl = new URL('../../../../backend/tests/fixtures/rag_tokenizer_golden.json', import.meta.url)
  const cases = JSON.parse(await readFile(fixtureUrl, 'utf8')) as GoldenCase[]
  for (const item of cases) {
    assert.deepEqual(tokenizeRaw(item.text), item.tokens, `tokenizer drift for ${item.text}`)
  }
})
