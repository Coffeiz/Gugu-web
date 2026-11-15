// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import DesktopWorkbench from '@/desktop/DesktopWorkbench.vue'

let app: ReturnType<typeof createApp> | undefined
let host: HTMLDivElement | undefined

async function flushUi() {
  await vi.waitFor(async () => {
    await nextTick()
    expect(host?.querySelector('button')?.disabled).toBe(false)
  })
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
  delete (window as any).guguDesktop
  localStorage.removeItem('gugu.desktop.pending-operation')
  vi.unstubAllGlobals()
})

describe('桌面本地工作台', () => {
  it('联系人重命名支持取消并在保存后重读', async () => {
    const rows = [{ id: 4, name: '旧联系人' }]
    const renameClient = vi.fn(async (id: number, name: string) => { rows[0] = { id, name }; return { ok: true, result: rows[0] } })
    ;(window as any).guguDesktop = { projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [...rows] }), renameClient, sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }) }
    const element = mountWorkbench(); await flushUi()
    const button = () => Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('重命名'))!
    button().click(); await nextTick()
    Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('取消'))!.click(); await nextTick()
    expect(renameClient).not.toHaveBeenCalled()
    button().click(); await nextTick()
    const input = element.querySelector<HTMLInputElement>('input[aria-label="联系人名称"]')!
    input.value = '新联系人'; input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(renameClient).toHaveBeenCalledWith(4, '新联系人')
    expect(element.textContent).toContain('新联系人')
  })
  it('重命名提交当前版本并重读列表，取消不发请求', async () => {
    const rows = [{ id: 3, name: '旧项目', version: 2 }]
    const renameProject = vi.fn(async (id: number, version: number, name: string) => {
      rows[0] = { id, name, version: version + 1 }
      return { ok: true, result: rows[0] }
    })
    ;(window as any).guguDesktop = { projects: async () => ({ ok: true, result: [...rows] }), clients: async () => ({ ok: true, result: [] }), renameProject, sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }) }
    const element = mountWorkbench()
    await flushUi()
    const button = () => Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('重命名'))!
    button().click(); await nextTick()
    Array.from(element.querySelectorAll('button')).find(item => item.textContent?.includes('取消'))!.click(); await nextTick()
    expect(renameProject).not.toHaveBeenCalled()
    button().click(); await nextTick()
    const input = element.querySelector<HTMLInputElement>('input[aria-label="项目名称"]')!
    input.value = '新项目'; input.dispatchEvent(new Event('input', { bubbles: true }))
    input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(renameProject).toHaveBeenCalledWith(3, 2, '新项目')
    expect(element.textContent).toContain('新项目')
    expect(element.textContent).toContain('v3')
  })
  it('创建后从 Core 重读列表，不依赖 Web 登录或 HTTP', async () => {
    const rows: { id: number; name: string; version: number }[] = []
    const createProject = vi.fn(async (name: string) => { rows.push({ id: 1, name, version: 1 }); return { ok: true, result: rows[0] } })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [...rows] }), createProject,
      clients: async () => ({ ok: true, result: [] }),
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench()
    await flushUi()
    const input = element.querySelector<HTMLInputElement>('#project-name')!
    input.value = '本地项目'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(element.textContent).toContain('本地项目')
    expect(element.textContent).toContain('Core 已连接')
    expect(createProject).toHaveBeenCalledWith('本地项目')
    expect(input.value).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('普通浏览器缺少原生桥时显示明确错误并结束忙碌状态', async () => {
    const element = mountWorkbench()
    await flushUi()
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('请在咕咕桌面应用中打开')
    expect(element.querySelector('button')?.disabled).toBe(false)
  })

  it('未知写入结果保留操作标识和输入，结束忙碌且不自动再次提交', async () => {
    const createProject = vi.fn(async () => ({ ok: false, error: { code: 'unknown_result', message: '结果未确认，请查询操作收据', operationId: '00000000-0000-4000-8000-000000000001' } }))
    ;(window as any).guguDesktop = { projects: async () => ({ ok: true, result: [] }), clients: async () => ({ ok: true, result: [] }), createProject, sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }) }
    const element = mountWorkbench()
    await flushUi()
    const input = element.querySelector<HTMLInputElement>('#project-name')!
    input.value = '待确认计划'; input.dispatchEvent(new Event('input', { bubbles: true }))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flushUi()
    expect(createProject).toHaveBeenCalledTimes(1)
    expect(input.value).toBe('待确认计划')
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('00000000-0000-4000-8000-000000000001')
    expect(localStorage.getItem('gugu.desktop.pending-operation')).toBe('00000000-0000-4000-8000-000000000001')
    expect(element.textContent).toContain('查询待确认操作')
    expect(element.querySelector('button')?.disabled).toBe(false)
  })

  it('重启后查到持久收据时刷新权威列表并清除待确认标识', async () => {
    localStorage.setItem('gugu.desktop.pending-operation', '00000000-0000-4000-8000-000000000001')
    const receipt = vi.fn(async () => ({ ok: true, result: { method: 'projects.create', result: { id: 1 } } }))
    ;(window as any).guguDesktop = {
      projects: async () => ({ ok: true, result: [{ id: 1, name: '收据中的项目', version: 1 }] }),
      clients: async () => ({ ok: true, result: [] }),
      receipt,
      sandboxStatus: async () => ({ ok: true, result: { supported: false, methods: [], checkAvailable: false } }),
    }
    const element = mountWorkbench()
    await flushUi()
    expect(receipt).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    expect(element.textContent).toContain('收据中的项目')
    expect(localStorage.getItem('gugu.desktop.pending-operation')).toBeNull()
  })
})
