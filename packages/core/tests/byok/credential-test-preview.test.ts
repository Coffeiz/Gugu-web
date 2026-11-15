import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createCredentialSavedTest, createCredentialTestPreview } from '../../src/byok/credential-test-preview.js'

interface TestDb {
  user_provider_credentials: {
    id: number; user_id: string; provider: string; api_format: string; base_url: string; model: string; capability: string; dimensions: number | null
    encrypted_value: string; nonce: string; encrypted_data_key: string; key_version: number
  }
}
const owner = '00000000-0000-4000-8000-000000000131'
const foreign = '00000000-0000-4000-8000-000000000132'
const db = new Kysely<TestDb>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) })
const decrypted: number[] = []
const probed: unknown[] = []

async function reset() {
  await db.schema.dropTable('user_provider_credentials').ifExists().execute()
  await db.schema.createTable('user_provider_credentials')
    .addColumn('id', 'integer', column => column.primaryKey())
    .addColumn('user_id', 'text', column => column.notNull())
    .addColumn('provider', 'text', column => column.notNull())
    .addColumn('api_format', 'text', column => column.notNull())
    .addColumn('base_url', 'text', column => column.notNull())
    .addColumn('model', 'text', column => column.notNull())
    .addColumn('capability', 'text', column => column.notNull())
    .addColumn('dimensions', 'integer')
    .addColumn('encrypted_value', 'text', column => column.notNull())
    .addColumn('nonce', 'text', column => column.notNull())
    .addColumn('encrypted_data_key', 'text', column => column.notNull())
    .addColumn('key_version', 'integer', column => column.notNull())
    .execute()
}

async function insertCredential(input: { id: number; user: string; baseUrl?: string }) {
  await db.insertInto('user_provider_credentials').values({
    id: input.id, user_id: input.user, provider: 'deepseek', api_format: 'openai',
    base_url: input.baseUrl ?? 'https://api.deepseek.example/v1', model: 'deepseek-v4', capability: 'llm', dimensions: null,
    encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1,
  }).execute()
}

afterEach(async () => {
  decrypted.length = 0
  probed.length = 0
  await reset()
})
beforeAll(reset)
afterAll(async () => { await db.destroy() })

describe('BYOK draft connection preview', () => {
  it('拒绝跨 owner 凭据，不解密、不探测，也不改动持久化数据', async () => {
    await insertCredential({ id: 1, user: foreign })
    const preview = createCredentialTestPreview(db, {
      enabled: () => true,
      decrypt: async row => { decrypted.push(1); return row.encrypted_value },
      probe: async input => { probed.push(input); return { ok: true, status: 200, detail: '' } },
    })

    await expect(preview(owner, {
      provider: 'deepseek', capability: 'llm', value: '', api_format: 'openai',
      base_url: 'https://api.deepseek.example/v1', model: 'deepseek-v4', credential_id: 1,
    })).rejects.toMatchObject({ code: 'not_found' })
    expect(decrypted).toEqual([])
    expect(probed).toEqual([])
    await expect(db.selectFrom('user_provider_credentials').selectAll().execute()).resolves.toHaveLength(1)
  })

  it('只为同一目的地解密并探测已保存 Key，且测试本身不写入数据库', async () => {
    await insertCredential({ id: 2, user: owner })
    const preview = createCredentialTestPreview(db, {
      enabled: () => true,
      decrypt: async row => { decrypted.push(1); return row.encrypted_value === 'cipher' ? 'stored-secret' : '' },
      probe: async input => { probed.push(input); return { ok: true, status: 200, detail: '' } },
    })

    await expect(preview(owner, {
      provider: 'deepseek', capability: 'llm', value: '', api_format: 'openai',
      base_url: 'https://other.example/v1', model: 'deepseek-v4', credential_id: 2,
    })).resolves.toMatchObject({ ok: false, status: 0 })
    expect(decrypted).toEqual([])
    expect(probed).toEqual([])

    await expect(preview(owner, {
      provider: 'deepseek', capability: 'llm', value: '', api_format: 'openai',
      base_url: 'https://api.deepseek.example/v1/', model: 'deepseek-v4', credential_id: 2,
    })).resolves.toMatchObject({ ok: true, status: 200, message: '模型连接正常' })
    expect(decrypted).toHaveLength(1)
    expect(probed).toMatchObject([{ provider: 'deepseek', apiKey: 'stored-secret', model: 'deepseek-v4' }])
    await expect(db.selectFrom('user_provider_credentials').selectAll().execute()).resolves.toHaveLength(1)
  })

  it('新填 Key 优先于已保存凭据，不查询或解密存量记录', async () => {
    await insertCredential({ id: 3, user: owner })
    const preview = createCredentialTestPreview(db, {
      enabled: () => true,
      decrypt: async () => { decrypted.push(1); return 'stored-secret' },
      probe: async input => { probed.push(input); return { ok: true, status: 204, detail: '' } },
    })
    await expect(preview(owner, {
      provider: 'other', capability: 'llm', value: 'new-secret', api_format: 'openai',
      base_url: 'https://provider.example/v1', model: 'model', credential_id: 3,
    })).resolves.toMatchObject({ ok: true, status: 204, message: '模型连接正常' })
    expect(decrypted).toEqual([])
    expect(probed).toMatchObject([{ provider: 'other', apiKey: 'new-secret' }])
  })

  it('BYOK gate、默认凭据和缺失 Key 保留旧结果语义', async () => {
    const disabled = createCredentialTestPreview(db, {
      enabled: () => false, decrypt: async () => 'unused', probe: async () => { throw new Error('must not probe') },
    })
    await expect(disabled(owner, { provider: 'deepseek', capability: 'llm', value: 'key' }))
      .rejects.toMatchObject({ statusCode: 403 })
    const enabled = createCredentialTestPreview(db, {
      enabled: () => true, decrypt: async () => 'unused', probe: async () => { throw new Error('must not probe') },
    })
    await expect(enabled(owner, { provider: '__server_default__', capability: 'llm', value: '' }))
      .resolves.toMatchObject({ ok: false, status: 0, message: '服务器默认配置不支持用户侧测试' })
    await expect(enabled(owner, { provider: 'deepseek', capability: 'llm', value: '' }))
      .resolves.toMatchObject({ ok: false, status: 0 })
  })

  it('允许无鉴权本地 Embedding 空 Key 试呼，并在目标字段缺失时不发请求', async () => {
    const enabled = createCredentialTestPreview(db, {
      enabled: () => true,
      decrypt: async () => { throw new Error('本地 Embedding 不应解密 Key') },
      probe: async input => { probed.push(input); return { ok: true, status: 200, detail: '', message: 'Embedding 连接正常' } },
    })
    await expect(enabled(owner, { provider: 'local', capability: 'embedding', base_url: 'http://127.0.0.1:11434/v1', model: 'bge-m3' }))
      .resolves.toMatchObject({ ok: true, status: 200, message: 'Embedding 连接正常' })
    expect(probed).toMatchObject([{ provider: 'local', capability: 'embedding', apiKey: '' }])
    probed.length = 0
    await expect(enabled(owner, { provider: 'local', capability: 'embedding', base_url: '', model: '' }))
      .resolves.toMatchObject({ ok: false, status: 0, message: 'Embedding 测试需要填写 Base URL 和模型名' })
    expect(probed).toEqual([])
  })

  it('测试已保存凭据时按 owner 读取并将解密后的 Key 用于无副作用 Provider 请求', async () => {
    await insertCredential({ id: 4, user: owner })
    const savedTest = createCredentialSavedTest(db, {
      enabled: () => true,
      decrypt: async row => { decrypted.push(1); return row.encrypted_value === 'cipher' ? 'saved-secret' : '' },
      probe: async input => { probed.push(input); return { ok: true, status: 200, detail: '' } },
    })
    await expect(savedTest(owner, 4)).resolves.toMatchObject({ ok: true, status: 200, message: '模型连接正常' })
    expect(decrypted).toHaveLength(1)
    expect(probed).toMatchObject([{ provider: 'deepseek', model: 'deepseek-v4', apiKey: 'saved-secret' }])
    await expect(savedTest(foreign, 4)).rejects.toMatchObject({ code: 'not_found' })
    expect(decrypted).toHaveLength(1)
    await expect(db.selectFrom('user_provider_credentials').selectAll().execute()).resolves.toHaveLength(1)
  })
})
