// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveBootstrap, sendMessage } from '../../../loopscope/frontend/src/services/gugu'

describe('LoopScope Cookie 认证', () => {
  beforeEach(() => {
    sessionStorage.clear()
    document.cookie = 'gugu_user_csrf_token=csrf%2Btoken; path=/'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')))
    saveBootstrap({ apiBase: `${window.location.origin}/gugu-api` })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
    document.cookie = 'gugu_user_csrf_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
  })

  it('发送消息时将 CSRF Cookie 放入请求头', async () => {
    await sendMessage('测试消息', null, () => {})

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf+token')
    expect(init?.credentials).toBe('include')
  })
})
