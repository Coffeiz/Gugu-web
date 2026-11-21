import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { messages } from '@/i18n/messages'
import SandboxAdmin from '@web/views/Admin/Sandbox/index.vue'
import type { SandboxStatus } from '@web/views/Admin/Sandbox/sandbox-status'

const stores = vi.hoisted(() => ({
  admin: { authFetch: vi.fn() },
  config: { fetchConfig: vi.fn(), saveConfig: vi.fn(), saveError: '',
    cfg: { storage: { backend: 'local' }, sandbox: {
      full_user_sandbox_authorization_enabled: true, terminal_mode: 'auto',
      ephemeral_quota_bytes: 1024 * 1024 * 1024, persistent_quota_bytes: 512 * 1024 * 1024,
    } } },
}))
vi.mock('@/stores/admin', () => ({ useAdminStore: () => stores.admin }))
vi.mock('@/stores/config', () => ({ useConfigStore: () => stores.config }))

let cleanup: (() => void) | undefined
beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup?.())

async function renderSandbox(overrides: Partial<SandboxStatus>) {
  const status: SandboxStatus = {
    enabled: true, shell_enabled: true, shell_dangerous_enabled: false, sandbox_ready: true,
    runtime_supported: true, runtime_methods: ['bubblewrap'], readiness_checked: true,
    state: 'ready', message: 'MXC Bubblewrap 执行环境已就绪', network_profile: 'none',
    egress_proxy_configured: false, egress_proxy_url: '', egress_network_ready: false,
    egress_config_error: null, egress_available: false, egress_enabled: false, ...overrides,
  }
  stores.admin.authFetch.mockImplementation(async () => ({ ok: true, json: async () => status }))
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp(SandboxAdmin)
  app.use(createI18n({ legacy: false, locale: 'zh-CN', messages }))
  app.mount(host)
  cleanup = () => { app.unmount(); host.remove(); cleanup = undefined }
  await vi.waitFor(() => expect(stores.admin.authFetch).toHaveBeenCalled())
  await nextTick()
  await nextTick()
  return { host, status }
}

it.each([{}, { execution_backend: 'bubblewrap' as const }])('断网 Bubblewrap 显示实际执行后端并隐藏代理操作', async (backend) => {
  const { host } = await renderSandbox(backend)
  expect(host.querySelector('h3')?.textContent).toBe('Bubblewrap 执行环境已就绪')
  expect(host.textContent).toContain('Shell 沙盒开关')
  expect(host.textContent).toContain('当前 Bubblewrap 后端固定断网')
  expect(host.textContent).not.toContain('MXC')
  expect(host.querySelector('input[type="url"]')).toBeNull()
  expect(host.querySelector('[aria-label="切换临时公网访问"]')).toBeNull()
})

it('直连后端未就绪且仍配置旧出站策略时，可以恢复为断网', async () => {
  const { host, status } = await renderSandbox({ execution_backend: 'bubblewrap', runtime_methods: [],
    runtime_supported: false, state: 'runtime_unavailable', message: '沙盒未就绪', network_profile: 'egress' })
  stores.config.saveConfig.mockImplementationOnce(async () => { status.network_profile = 'none' })
  const restore = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === '切换为断网')
  expect(restore).toBeDefined()
  restore?.click()
  await vi.waitFor(() => {
    expect(stores.config.saveConfig).toHaveBeenCalledWith({ sandbox: { network_profile: 'none' } })
    expect(host.textContent).not.toContain('切换为断网')
  })
})

it('仍支持受控出站的后端保留代理表单和开关', async () => {
  const { host } = await renderSandbox({ egress_network_ready: true, egress_available: true })
  expect(host.querySelector('input[type="url"]')).not.toBeNull()
  expect(host.querySelector('[aria-label="切换临时公网访问"]')).not.toBeNull()
})
