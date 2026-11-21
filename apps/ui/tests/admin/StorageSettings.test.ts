// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import StorageSettings from '@web/views/Admin/Config/components/StorageSettings.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = undefined
  host = undefined
})

function mountStorage(storage: Record<string, unknown>) {
  const state = reactive(storage)
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    setup: () => () => h(StorageSettings, {
      modelValue: state,
      'onUpdate:modelValue': (value: Record<string, unknown>) => Object.assign(state, value),
    }),
  })
  app.mount(host)
  return { state, host }
}

describe('Admin 文件存储设置', () => {
  it('仅提供 Local 存储路径，不再暴露 OSS 测试入口', async () => {
    const { host, state } = mountStorage({ backend: 'local', local_path: '/tmp/gugu-users' })
    await nextTick()

    expect(host.textContent).toContain('configUi.fileStorage')
    expect(host.textContent).toContain('configUi.storagePath')
    expect(host.querySelector('input')?.value).toBe('/tmp/gugu-users')
    expect(host.textContent).not.toContain('configUi.aliyunOss')
    expect(host.textContent).not.toContain('configUi.testOss')

    const input = host.querySelector<HTMLInputElement>('input')
    expect(input).not.toBeNull()
    input!.value = '/tmp/updated-users'
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(state.local_path).toBe('/tmp/updated-users')
  })

  it('遇到旧 OSS 配置时提示不支持且不显示密钥或测试按钮', async () => {
    const { host } = mountStorage({
      backend: 'oss',
      local_path: '/tmp/gugu-users',
      oss_access_key_id: 'secret-id',
      oss_access_key_secret: 'secret-value',
    })
    await nextTick()

    expect(host.textContent).toContain('configUi.storageUnsupported')
    expect(host.textContent).not.toContain('secret-id')
    expect(host.textContent).not.toContain('secret-value')
    expect(host.querySelector('input')).toBeNull()
    expect(host.querySelector('button')).toBeNull()
  })
})
