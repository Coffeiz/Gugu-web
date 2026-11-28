import assert from 'node:assert/strict'
import test from 'node:test'
import { createPostgresAgentEmbeddingSettingsResolver } from '../../src/modules/byok/store.js'

test('embedding BYOK 仅对明确的 local/ollama provider 返回本地访问标记', async () => {
  let provider = 'openai'
  let gateReads = 0
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    async query(sql: string, values: unknown[]) {
      queries.push({ sql, values })
      return { rows: [{ provider, base_url: 'http://127.0.0.1:11434/v1', model: 'synthetic-embedding', dimensions: 2,
        encrypted_value: 'ciphertext', nonce: 'nonce', encrypted_data_key: 'wrapped-key', key_version: 1 }] }
    },
  }
  const resolve = createPostgresAgentEmbeddingSettingsResolver(pool as never, {
    async enabled() { gateReads += 1; return true },
    async decrypt(row) { assert.equal(row.encrypted_value, 'ciphertext'); return 'synthetic-key' },
  })

  const owner = '00000000-0000-4000-8000-000000000101'
  const cloud = await resolve(owner, new AbortController().signal)
  assert.equal(cloud?.allowLocal, false)
  assert.equal(cloud?.apiKey, 'synthetic-key')

  provider = 'ollama'
  const local = await resolve(owner, new AbortController().signal)
  assert.equal(local?.allowLocal, true)
  assert.equal(queries.length, 2)
  assert.deepEqual(queries.map(query => query.values), [[owner], [owner]])
  assert.equal(gateReads, 4)
})

test('embedding 设置在授权关闭和取消时不读取或解密凭据', async () => {
  let queries = 0
  let decryptions = 0
  const resolve = createPostgresAgentEmbeddingSettingsResolver({
    async query() { queries += 1; return { rows: [] } },
  } as never, {
    enabled: () => false,
    async decrypt() { decryptions += 1; return 'synthetic-key' },
  })
  assert.equal(await resolve('00000000-0000-4000-8000-000000000101'), null)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(resolve('00000000-0000-4000-8000-000000000101', controller.signal))
  assert.equal(queries, 0)
  assert.equal(decryptions, 0)
})
