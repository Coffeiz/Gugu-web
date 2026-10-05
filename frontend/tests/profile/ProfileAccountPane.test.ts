// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ProfileAccountPane from '@/components/common/profile/ProfileAccountPane.vue'

const mocks = vi.hoisted(() => ({
  preferences: {
    emailChangeEnabled: false,
    loaded: false,
    fetch: vi.fn(),
  },
  auth: {
    updateProfile: vi.fn(),
  },
  requestEmailChange: vi.fn(),
  resendEmailChange: vi.fn(),
  cancelEmailChange: vi.fn(),
}))

vi.mock('@/stores/preferences', () => ({
  usePreferencesStore: () => mocks.preferences,
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => mocks.auth,
}))

vi.mock('@/services/api', () => ({
  authApi: {
    requestEmailChange: mocks.requestEmailChange,
    resendEmailChange: mocks.resendEmailChange,
    cancelEmailChange: mocks.cancelEmailChange,
  },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

function mountPane() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(ProfileAccountPane)
  app.mount(host)
  return host
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  mocks.preferences.emailChangeEnabled = false
  mocks.preferences.loaded = false
  mocks.preferences.fetch.mockReset()
  mocks.auth.updateProfile.mockReset()
  mocks.requestEmailChange.mockReset().mockResolvedValue(undefined)
  mocks.resendEmailChange.mockReset().mockResolvedValue(undefined)
  mocks.cancelEmailChange.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

describe('账号安全入口', () => {
  it('邮箱变更能力关闭时隐藏入口，并在偏好尚未加载时请求配置', () => {
    const root = mountPane()

    expect(root.querySelector('.email-change-section')).toBeNull()
    expect(mocks.preferences.fetch).toHaveBeenCalledOnce()
  })

  it('提交邮箱变更时发送去空格后的地址，成功后清空凭据并进入待确认状态', async () => {
    mocks.preferences.emailChangeEnabled = true
    mocks.preferences.loaded = true
    const root = mountPane()

    expect(mocks.preferences.fetch).not.toHaveBeenCalled()
    expect(root.querySelector('.email-change-section')).not.toBeNull()

    const email = root.querySelector('input[type="email"]') as HTMLInputElement
    const password = root.querySelector('.email-change-section input[type="password"]') as HTMLInputElement
    setInputValue(email, '  person@example.test  ')
    setInputValue(password, 'synthetic-password')
    await nextTick()

    const submit = root.querySelector('.email-change-section .pm-save-btn') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    submit.click()
    await flushUi()

    expect(mocks.requestEmailChange).toHaveBeenCalledWith({
      newEmail: 'person@example.test',
      currentPassword: 'synthetic-password',
    })
    expect(email.value).toBe('')
    expect(password.value).toBe('')
    expect(root.querySelector('.email-change-hint')?.textContent).toContain('emailChangeUi.sentHint')
    expect(root.querySelectorAll('.email-change-actions button')).toHaveLength(2)

    const [resend, cancel] = root.querySelectorAll('.email-change-actions button') as NodeListOf<HTMLButtonElement>
    resend.click()
    await flushUi()
    expect(mocks.resendEmailChange).toHaveBeenCalledOnce()

    cancel.click()
    await flushUi()
    expect(mocks.cancelEmailChange).toHaveBeenCalledOnce()
    expect(root.querySelector('.email-change-hint')).toBeNull()
    expect(root.querySelector('.email-change-section .pm-save-btn')?.textContent).toContain('emailChangeUi.submit')
  })

  it('申请失败时保留输入并显示错误，允许用户重试', async () => {
    mocks.preferences.emailChangeEnabled = true
    mocks.preferences.loaded = true
    mocks.requestEmailChange.mockRejectedValueOnce(new Error('邮箱地址不可用'))
    const root = mountPane()

    const email = root.querySelector('input[type="email"]') as HTMLInputElement
    const password = root.querySelector('.email-change-section input[type="password"]') as HTMLInputElement
    setInputValue(email, 'person@example.test')
    setInputValue(password, 'synthetic-password')
    await nextTick()

    ;(root.querySelector('.email-change-section .pm-save-btn') as HTMLButtonElement).click()
    await flushUi()

    expect(mocks.requestEmailChange).toHaveBeenCalledOnce()
    expect(email.value).toBe('person@example.test')
    expect(password.value).toBe('synthetic-password')
    expect(root.querySelector('.email-change-section .pm-msg')?.textContent).toBe('邮箱地址不可用')
    expect((root.querySelector('.email-change-section .pm-save-btn') as HTMLButtonElement).disabled).toBe(false)
  })
})
