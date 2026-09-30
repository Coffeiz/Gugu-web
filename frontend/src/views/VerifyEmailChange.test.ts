// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import VerifyEmailChange from '@/views/VerifyEmailChange.vue'

const mocks = vi.hoisted(() => ({
  route: { query: { token: 'synthetic-token' } as Record<string, string | string[] | undefined> },
  push: vi.fn(),
  verifyEmailChange: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => mocks.route,
    useRouter: () => ({ push: mocks.push }),
  }
})

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>()
  return {
    ...actual,
    authApi: { ...actual.authApi, verifyEmailChange: mocks.verifyEmailChange },
  }
})

vi.mock('@/layouts/DefaultLayout.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: null, isLoggedIn: false }),
}))

vi.mock('@/components/common/auth/AuthBrand.vue', () => ({
  default: { template: '<div />' },
}))

vi.mock('@/components/common/auth/AuthLanguageSwitcher.vue', () => ({
  default: { template: '<div />' },
}))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountPage() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(VerifyEmailChange)
  app.mount(host)
  return host
}

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  mocks.route.query = { token: 'synthetic-token' }
  mocks.push.mockReset()
  mocks.verifyEmailChange.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

describe('邮箱变更验证页', () => {
  it('读取单个短期 token 并显示验证成功结果', async () => {
    const root = mountPage()
    await flushUi()

    expect(mocks.verifyEmailChange).toHaveBeenCalledOnce()
    expect(mocks.verifyEmailChange).toHaveBeenCalledWith('synthetic-token')
    expect(root.querySelector('.verify-state.success')?.textContent).toBe('emailChangeUi.verified')
    expect(root.querySelector('.verify-state.error')).toBeNull()
  })

  it('缺少或重复 token 时不请求验证接口并显示失败结果', async () => {
    mocks.route.query = { token: ['first-token', 'second-token'] }
    const root = mountPage()
    await flushUi()

    expect(mocks.verifyEmailChange).not.toHaveBeenCalled()
    expect(root.querySelector('.verify-state.error')?.textContent).toBe('emailChangeUi.verifyFailed')
  })

  it('验证接口拒绝时展示错误，继续按钮导航到登录页', async () => {
    mocks.verifyEmailChange.mockRejectedValueOnce(new Error('链接已过期'))
    const root = mountPage()
    await flushUi()

    expect(root.querySelector('.verify-state.error')?.textContent).toBe('链接已过期')
    ;(root.querySelector('button.btn-primary') as HTMLButtonElement).click()
    expect(mocks.push).toHaveBeenCalledWith('/login')
  })

  it('真实路由将验证页标记为公开页面', async () => {
    const routerModule = await import('@/router')
    const resolved = routerModule.default.resolve('/verify-email-change?token=synthetic-token')

    expect(resolved.name).toBe('VerifyEmailChange')
    expect(resolved.meta.authPublic).toBe(true)
  })
})
