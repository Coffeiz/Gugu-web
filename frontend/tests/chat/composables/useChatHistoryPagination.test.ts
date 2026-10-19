import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentApi } from '@/services/api'
import { useChatHistoryPagination } from '@/components/common/gugu-chat/composables/useChatHistoryPagination'
import type { ChatMessage } from '@/components/common/gugu-chat/chatTypes'

vi.mock('@/services/api', () => ({ agentApi: { getMessagesBefore: vi.fn() } }))
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.resetAllMocks() })
function setup() {
  const scope = effectScope(); scopes.push(scope)
  const messages = ref<ChatMessage[]>([])
  const sessionId = ref<number | null>(1)
  let id = 0
  const beforeMerge = vi.fn()
  const viewGeneration = ref(0)
  const api = scope.run(() => useChatHistoryPagination({
    messages, sessionId, settling: ref(false), mkid: () => ++id,
    resolveSpeaker: role => ({ role: role === 'assistant' ? 'ai' : 'user' }), beforeMerge,
    getViewGeneration: () => viewGeneration.value,
  }))!
  api.reset({ hasMore: true, oldestId: 100 })
  return { api, messages, sessionId, scope, beforeMerge, viewGeneration }
}
function page(ids: number[], hasMore = false) {
  return { messages: ids.map(id => ({ id, role: 'user', content: `消息${id}`, createdAt: '2026-10-19T01:00:00Z', timelineOrder: id * 1000 })), pagination: { oldestId: Math.min(...ids), hasMore } }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

describe('聊天历史分页', () => {
  it('按返回游标逐页读取，排序去重且保留已有气泡身份', async () => {
    const { api, messages } = setup()
    vi.mocked(agentApi.getMessagesBefore).mockResolvedValueOnce(page([80, 90], true)).mockResolvedValueOnce(page([70, 80]))
    await api.loadOlder()
    const stableId = messages.value.find(item => item.dbId === 80)!.id
    await api.loadOlder()
    expect(agentApi.getMessagesBefore).toHaveBeenNthCalledWith(2, '1', 80, 50)
    expect(messages.value.map(item => item.dbId)).toEqual([70, 80, 90])
    expect(messages.value.find(item => item.dbId === 80)!.id).toBe(stableId)
    expect(api.state.value.hasMore).toBe(false)
    await api.loadOlder()
    expect(agentApi.getMessagesBefore).toHaveBeenCalledTimes(2)
  })
  it('每次只保留一个请求，切会话后旧响应不得写入', async () => {
    const { api, messages, sessionId, beforeMerge } = setup()
    const request = deferred<ReturnType<typeof page>>()
    vi.mocked(agentApi.getMessagesBefore).mockReturnValueOnce(request.promise)
    const pending = api.loadOlder()
    await api.loadOlder()
    expect(agentApi.getMessagesBefore).toHaveBeenCalledTimes(1)
    sessionId.value = 2
    request.resolve(page([80]))
    await pending
    expect(messages.value).toEqual([])
    expect(beforeMerge).not.toHaveBeenCalled()
    expect(api.state.value.loading).toBe(false)
  })
  it('失败后保留游标，停止自动重试，手动重试可继续', async () => {
    const { api } = setup()
    vi.mocked(agentApi.getMessagesBefore).mockRejectedValueOnce(new Error('合成错误')).mockResolvedValueOnce(page([80]))
    await api.loadOlder()
    await api.loadOlder()
    expect(agentApi.getMessagesBefore).toHaveBeenCalledTimes(1)
    expect(api.state.value.error).toBe(true)
    await api.loadOlder(true)
    expect(agentApi.getMessagesBefore).toHaveBeenLastCalledWith('1', 100, 50)
    expect(api.state.value.error).toBe(false)
  })
  it('游标不前进时拒绝合并，避免无限请求同一页', async () => {
    const { api, messages } = setup()
    vi.mocked(agentApi.getMessagesBefore).mockResolvedValueOnce(page([100], true))
    await api.loadOlder()
    expect(api.state.value.error).toBe(true)
    expect(messages.value).toEqual([])
  })
  it('卸载后丢弃在途响应', async () => {
    const { api, messages, scope } = setup()
    const request = deferred<ReturnType<typeof page>>()
    vi.mocked(agentApi.getMessagesBefore).mockReturnValueOnce(request.promise)
    const pending = api.loadOlder()
    scope.stop()
    request.resolve(page([80]))
    await pending
    expect(messages.value).toEqual([])
  })
  it('同一会话重新加载期间也丢弃旧页响应', async () => {
    const { api, messages, viewGeneration } = setup()
    const request = deferred<ReturnType<typeof page>>()
    vi.mocked(agentApi.getMessagesBefore).mockReturnValueOnce(request.promise)
    const pending = api.loadOlder()
    viewGeneration.value++
    request.resolve(page([80]))
    await pending
    expect(messages.value).toEqual([])
    expect(api.state.value.loading).toBe(false)
  })
  it('空页结束分页，不反复访问已清理的旧历史', async () => {
    const { api } = setup()
    vi.mocked(agentApi.getMessagesBefore).mockResolvedValueOnce({ messages: [], pagination: { oldestId: null, hasMore: false } })
    await api.loadOlder()
    await api.loadOlder()
    expect(api.state.value.hasMore).toBe(false)
    expect(api.state.value.error).toBe(false)
    expect(agentApi.getMessagesBefore).toHaveBeenCalledTimes(1)
  })

})
