import { afterEach, describe, expect, it, vi } from 'vitest'
import { mcpApi, type McpServerItem } from '@/services/api'
import { useMcpStatusLoader } from '@/views/Skills/composables/useMcpStatusLoader'

function server(id: string, enabled = true, state = 'unloaded') {
  return { id, enabled, state } as McpServerItem
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('useMcpStatusLoader', () => {
  afterEach(() => vi.restoreAllMocks())

  it('首屏只并发加载未加载的启用服务，并在单个结果返回时立即更新该卡片', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<{
      ok: boolean
      state: string
      tool_count: number
      tool_names?: string[]
    }>>>()
    const loadStatus = vi.spyOn(mcpApi, 'loadStatus').mockImplementation(id => {
      const request = deferred<{
        ok: boolean
        state: string
        tool_count: number
        tool_names?: string[]
      }>()
      pending.set(id, request)
      return request.promise
    })
    const loader = useMcpStatusLoader()
    const updates: Array<[string, string, number]> = []

    const loading = loader.refresh([
      server('one'), server('two'), server('three'), server('four'),
      server('already_loaded', true, 'ok'), server('disabled', false),
    ], (id, status) => updates.push([id, status.state, status.tool_count]))

    expect([...loader.checkingIds.value]).toEqual(['one', 'two', 'three', 'four'])
    expect(loadStatus).toHaveBeenCalledTimes(3)
    expect(loadStatus).not.toHaveBeenCalledWith('already_loaded')
    expect(loadStatus).not.toHaveBeenCalledWith('disabled')

    pending.get('one')?.resolve({ ok: true, state: 'ok', tool_count: 2, tool_names: ['one_a', 'one_b'] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(updates).toEqual([['one', 'ok', 2]])
    expect(loadStatus).toHaveBeenCalledTimes(4)

    pending.get('two')?.resolve({ ok: true, state: 'ok', tool_count: 1 })
    pending.get('three')?.resolve({ ok: false, state: 'error', tool_count: 0 })
    pending.get('four')?.resolve({ ok: true, state: 'ok', tool_count: 0 })
    await loading

    expect(updates).toHaveLength(4)
    expect(loader.checkingIds.value.size).toBe(0)
  })

  it('页面刷新或卸载后忽略旧请求结果', async () => {
    const request = deferred<{ ok: boolean; state: string; tool_count: number }>()
    vi.spyOn(mcpApi, 'loadStatus').mockReturnValue(request.promise)
    const loader = useMcpStatusLoader()
    const update = vi.fn()
    const loading = loader.refresh([server('one')], update)

    loader.cancel()
    request.resolve({ ok: true, state: 'ok', tool_count: 3 })
    await loading

    expect(update).not.toHaveBeenCalled()
    expect(loader.checkingIds.value.size).toBe(0)
  })
})
