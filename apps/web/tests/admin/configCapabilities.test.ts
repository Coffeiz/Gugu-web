import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('@/stores/admin', () => ({ useAdminStore: () => ({ authFetch: mocks.authFetch }) }))

import { useConfigStore } from '@/stores/config'

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.authFetch.mockReset()
})

it('Node Host 明确交由部署迁移 schema 时关闭 Admin 初始化操作', async () => {
  mocks.authFetch.mockResolvedValue({ json: async () => ({
    data: { db: { host: 'db.synthetic.invalid', port: 5432, name: 'gugu', user: 'synthetic', password: '****' } },
    capabilities: { database_schema_managed_externally: true },
  }) })
  const store = useConfigStore()
  expect(store.databaseInitializationSupported).toBe(false)
  await store.fetchConfig()
  expect(store.databaseInitializationSupported).toBe(false)
})

it('旧 Python Host 未声明部署能力时保留数据库初始化兼容入口', async () => {
  mocks.authFetch.mockResolvedValue({ json: async () => ({ data: { db: { host: 'localhost' } } }) })
  const store = useConfigStore()
  expect(store.databaseInitializationSupported).toBe(false)
  await store.fetchConfig()
  expect(store.databaseInitializationSupported).toBe(true)
})
