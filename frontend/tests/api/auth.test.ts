// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApi } from '@/api/auth'
import { authApi as compatibilityAuthApi } from '@/services/api'
import { getAuthDeviceId } from '@/utils/authDevice'
import { jsonResponse } from './response'

afterEach(() => {
  localStorage.clear()
  document.cookie = 'gugu_user_csrf_token=; Max-Age=0; path=/'
  vi.unstubAllGlobals()
})

describe('认证 API 模块', () => {
  it('旧 services 入口继续导出同一个认证 API 模块', () => {
    expect(compatibilityAuthApi).toBe(authApi)
  })

  it('注册码请求保留持久设备限流头', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    await authApi.sendRegistrationCode('user@example.invalid')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/v1/auth/registration-code')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'X-Device-ID': getAuthDeviceId() })
    expect(init?.body).toBe(JSON.stringify({ email: 'user@example.invalid' }))
  })

  it('邮箱变更请求保留原路径和请求字段', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const payload = { newEmail: 'next@example.invalid', currentPassword: 'synthetic-password' }

    await authApi.requestEmailChange(payload)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/email-change/request')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify(payload))
  })
})
