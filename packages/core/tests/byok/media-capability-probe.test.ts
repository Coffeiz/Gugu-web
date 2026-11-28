import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createByokMediaCapabilityProbe } from '../../../../apps/web-host/src/modules/byok/checks/capabilities.js'

interface TestDb {
  user_provider_credentials: {
    id: number; user_id: string; provider: string; api_format: string; base_url: string; model: string; capability: string
    encrypted_value: string; nonce: string; encrypted_data_key: string; key_version: number
  }
}
const owner = '00000000-0000-4000-8000-000000000121'
const foreign = '00000000-0000-4000-8000-000000000122'
const db = new Kysely<TestDb>({ dialect: new SqliteDialect({ database: new Database(':memory:') }) })
const decryptCalls: number[] = []
const probeCalls: unknown[] = []

afterEach(async () => {
  decryptCalls.length = 0
  probeCalls.length = 0
})
afterAll(async () => { await db.destroy() })

describe('BYOK media capability probe', () => {
  it('拒绝跨 owner 凭据并保持凭据数据不变', async () => {
    await db.schema.dropTable('user_provider_credentials').ifExists().execute()
    await db.schema.createTable('user_provider_credentials')
      .addColumn('id', 'integer', column => column.primaryKey())
      .addColumn('user_id', 'text', column => column.notNull())
      .addColumn('provider', 'text', column => column.notNull())
      .addColumn('api_format', 'text', column => column.notNull())
      .addColumn('base_url', 'text', column => column.notNull())
      .addColumn('model', 'text', column => column.notNull())
      .addColumn('capability', 'text', column => column.notNull())
      .addColumn('encrypted_value', 'text', column => column.notNull())
      .addColumn('nonce', 'text', column => column.notNull())
      .addColumn('encrypted_data_key', 'text', column => column.notNull())
      .addColumn('key_version', 'integer', column => column.notNull())
      .execute()
    await db.insertInto('user_provider_credentials').values({
      id: 1, user_id: foreign, provider: 'deepseek', api_format: 'openai', base_url: 'https://api.deepseek.example/v1',
      model: 'deepseek-v4', capability: 'llm', encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1,
    }).execute()
    const operation = createByokMediaCapabilityProbe(db, {
      enabled: () => true,
      decrypt: async row => { decryptCalls.push(1); return row.encrypted_value },
      probe: async (target, dim) => { probeCalls.push({ target, dim }); return { supported: true, status: 200, detail: 'ok' } },
    })

    await expect(operation(owner, {
      provider: 'deepseek', api_format: 'openai', base_url: 'https://api.deepseek.example/v1', model: 'deepseek-v4',
      api_key: '', credential_id: 1, dim: 'image',
    })).rejects.toMatchObject({ code: 'not_found' })
    expect(decryptCalls).toEqual([])
    expect(probeCalls).toEqual([])
    await expect(db.selectFrom('user_provider_credentials').selectAll().execute()).resolves.toHaveLength(1)
  })

  it('只为相同目的地解密 owner 凭据并探测，目的地变化返回422且没有副作用', async () => {
    await db.schema.dropTable('user_provider_credentials').ifExists().execute()
    await db.schema.createTable('user_provider_credentials')
      .addColumn('id', 'integer', column => column.primaryKey())
      .addColumn('user_id', 'text', column => column.notNull())
      .addColumn('provider', 'text', column => column.notNull())
      .addColumn('api_format', 'text', column => column.notNull())
      .addColumn('base_url', 'text', column => column.notNull())
      .addColumn('model', 'text', column => column.notNull())
      .addColumn('capability', 'text', column => column.notNull())
      .addColumn('encrypted_value', 'text', column => column.notNull())
      .addColumn('nonce', 'text', column => column.notNull())
      .addColumn('encrypted_data_key', 'text', column => column.notNull())
      .addColumn('key_version', 'integer', column => column.notNull())
      .execute()
    await db.insertInto('user_provider_credentials').values({
      id: 2, user_id: owner, provider: 'deepseek', api_format: 'openai', base_url: 'https://api.deepseek.example/v1',
      model: 'deepseek-v4', capability: 'llm', encrypted_value: 'cipher', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1,
    }).execute()
    const operation = createByokMediaCapabilityProbe(db, {
      enabled: () => true,
      decrypt: async row => { decryptCalls.push(1); return row.encrypted_value === 'cipher' ? 'stored-secret' : '' },
      probe: async (target, dim) => { probeCalls.push({ target, dim }); return { supported: true, status: 200, detail: 'ok' } },
    })

    await expect(operation(owner, {
      provider: 'minimax', api_format: 'anthropic', base_url: 'https://api.minimax.example/v1', model: 'm3',
      api_key: '', credential_id: 2, dim: 'image',
    })).rejects.toMatchObject({ statusCode: 422 })
    expect(decryptCalls).toEqual([])
    expect(probeCalls).toEqual([])

    await expect(operation(owner, {
      provider: 'deepseek', api_format: 'openai', base_url: 'https://api.deepseek.example/v1/', model: 'deepseek-v4',
      api_key: '', credential_id: 2, dim: 'image',
    })).resolves.toMatchObject({ dim: 'image', supported: true, status: 200 })
    expect(decryptCalls).toHaveLength(1)
    expect(probeCalls).toHaveLength(1)
    expect(probeCalls[0]).toMatchObject({ target: { apiKey: 'stored-secret' }, dim: 'image' })
    await expect(db.selectFrom('user_provider_credentials').selectAll().execute()).resolves.toHaveLength(1)
  })

  it('BYOK gate and missing key reject with legacy status semantics', async () => {
    const operation = createByokMediaCapabilityProbe(db, {
      enabled: () => false,
      decrypt: async () => 'unused',
      probe: async () => { throw new Error('must not probe') },
    })
    await expect(operation(owner, { provider: 'deepseek', api_format: 'openai', base_url: '', model: '', api_key: 'key', dim: 'image' }))
      .rejects.toMatchObject({ statusCode: 403 })

    const enabled = createByokMediaCapabilityProbe(db, {
      enabled: () => true,
      decrypt: async () => 'unused',
      probe: async () => { throw new Error('must not probe') },
    })
    await expect(enabled(owner, { provider: 'deepseek', api_format: 'openai', base_url: '', model: '', api_key: '', dim: 'image' }))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('已保存凭据解密为空时在探测前返回422，不向 Provider 发送空凭据', async () => {
    await db.schema.dropTable('user_provider_credentials').ifExists().execute()
    await db.schema.createTable('user_provider_credentials')
      .addColumn('id', 'integer', column => column.primaryKey())
      .addColumn('user_id', 'text', column => column.notNull())
      .addColumn('provider', 'text', column => column.notNull())
      .addColumn('api_format', 'text', column => column.notNull())
      .addColumn('base_url', 'text', column => column.notNull())
      .addColumn('model', 'text', column => column.notNull())
      .addColumn('capability', 'text', column => column.notNull())
      .addColumn('encrypted_value', 'text', column => column.notNull())
      .addColumn('nonce', 'text', column => column.notNull())
      .addColumn('encrypted_data_key', 'text', column => column.notNull())
      .addColumn('key_version', 'integer', column => column.notNull())
      .execute()
    await db.insertInto('user_provider_credentials').values({
      id: 3, user_id: owner, provider: 'deepseek', api_format: 'openai', base_url: 'https://api.deepseek.example/v1',
      model: 'deepseek-v4', capability: 'llm', encrypted_value: '', nonce: 'nonce', encrypted_data_key: 'wrapped', key_version: 1,
    }).execute()
    const operation = createByokMediaCapabilityProbe(db, {
      enabled: () => true, decrypt: async () => '',
      probe: async (_target, dim) => { probeCalls.push(dim); return { supported: true, status: 200, detail: 'ok' } },
    })
    await expect(operation(owner, {
      provider: 'deepseek', api_format: 'openai', base_url: 'https://api.deepseek.example/v1', model: 'deepseek-v4',
      api_key: '', credential_id: 3, dim: 'image',
    })).rejects.toMatchObject({ statusCode: 422 })
    expect(probeCalls).toEqual([])
    await expect(db.selectFrom('user_provider_credentials').selectAll().execute()).resolves.toHaveLength(1)
  })
})
