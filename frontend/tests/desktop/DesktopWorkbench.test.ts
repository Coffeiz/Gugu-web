// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import DesktopWorkbench from '@/desktop/DesktopWorkbench.vue'

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

async function flushUi() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function mountWorkbench() {
  host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DesktopWorkbench)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  delete (window as any).__TAURI__
  vi.unstubAllGlobals()
})

describe('桌面本地工作台', () => {
  it('创建后从 Core 重读列表，不依赖 Web 登录或 HTTP', async () => {
    const rows: { id: number; name: string; version: number }[] = []
    const invoke = vi.fn(async (command, args) => {
      if (command === 'sandbox_status') return { supported: false, methods: [], checkAvailable: false }
      if (args.method === 'projects.create') { rows.push({ id: 1, name: args.params.name, version: 1 }); return rows[0] }
      if (args.method === 'projects.list') return [...rows]
      if (args.method === 'clients.list') return []
      throw new Error('不支持的测试请求')
    })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    ;(window as any).__TAURI__ = { core: { invoke } }
    const element = mountWorkbench()
    await flushUi()
    const input = element.querySelector<HTMLInputElement>('#project-name')!
    input.value = '本地项目'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(element.textContent).toContain('本地项目')
    expect(element.textContent).toContain('Core 已连接')
    expect(invoke).toHaveBeenCalledWith('core_request', { method: 'projects.create', params: { name: '本地项目' } })
    expect(input.value).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('普通浏览器缺少原生桥时显示明确错误并结束忙碌状态', async () => {
    const element = mountWorkbench()
    await flushUi()
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('请在咕咕桌面应用中打开')
    expect(element.querySelector('button')?.disabled).toBe(false)
  })
})
