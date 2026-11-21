import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock('@/stores/admin', () => ({ useAdminStore: () => ({ authFetch: mocks.authFetch }) }))

import { useDatabaseInitialization } from '@web/views/Admin/Config/composables/useDatabaseInitialization'

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.authFetch.mockReset()
})

it('旧 Host 支持初始化时仍调用原 API 并返回用户可见结果', async () => {
  mocks.authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, message: '数据库表已创建/已就绪' }) })
  const { loading, initialize } = useDatabaseInitialization()
  const result = await initialize()
  expect(mocks.authFetch).toHaveBeenCalledWith('/api/v1/admin/config/init-db', { method: 'POST' })
  expect(result).toEqual({ ok: true, message: '数据库表已创建/已就绪' })
  expect(loading.value).toBe(false)
})

it('初始化 API 返回失败状态时保留服务端安全错误说明', async () => {
  mocks.authFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: '数据库服务暂不可用' }) })
  const { initialize } = useDatabaseInitialization()
  expect(await initialize()).toEqual({ ok: false, message: '数据库服务暂不可用' })
})
