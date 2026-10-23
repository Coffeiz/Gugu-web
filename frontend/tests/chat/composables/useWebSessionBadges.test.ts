import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWebSessionBadges } from '@/components/common/gugu-chat/composables/useWebSessionBadges'
import type { ChatSession } from '@/components/common/gugu-chat/chatTypes'

const scopes: ReturnType<typeof effectScope>[] = []
beforeEach(() => localStorage.clear())
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.restoreAllMocks() })

function create(sessions: ChatSession[] = [{ id: 1, title: '合成对话', lastAssistantId: 10 }]) {
  const options = { sessions: ref(sessions), sessionId: ref<number | null>(null),
    visible: ref(true), accountId: ref<string | null>('synthetic-a') }
  const scope = effectScope()
  scopes.push(scope)
  const badges = scope.run(() => useWebSessionBadges(options))!
  return { ...options, badges }
}

describe('站内会话运行和未读状态', () => {
  it('首次建立历史基线，运行中优先，后台完成后未读，打开后清除', async () => {
    const state = create()
    await nextTick()
    expect(state.badges.value).toEqual({})
    state.sessions.value = [{ id: 1, title: '合成对话', lastAssistantId: 10, isRunning: true }]
    await nextTick()
    expect(state.badges.value[1]).toBe('running')
    state.sessions.value = [{ id: 1, title: '合成对话', lastAssistantId: 20, isRunning: false }]
    await nextTick()
    expect(state.badges.value[1]).toBe('unread')
    state.sessionId.value = 1
    await nextTick()
    expect(state.badges.value).toEqual({})
  })

  it('当前可见会话完成不产生未读；关闭窗口后相同会话完成仍为未读', async () => {
    const state = create()
    state.sessionId.value = 1
    state.sessions.value = [{ id: 1, title: '合成对话', lastAssistantId: 20 }]
    await nextTick()
    expect(state.badges.value).toEqual({})
    state.visible.value = false
    state.sessions.value = [{ id: 1, title: '合成对话', lastAssistantId: 30 }]
    await nextTick()
    expect(state.badges.value[1]).toBe('unread')
    state.visible.value = true
    await nextTick()
    expect(state.badges.value).toEqual({})
  })

  it('刷新重建后保留已读版本，只对新回复显示未读', async () => {
    create()
    await nextTick()
    const state = create([{ id: 1, title: '合成对话', lastAssistantId: 20 }])
    await nextTick()
    expect(state.badges.value[1]).toBe('unread')
  })

  it('浏览器标签页隐藏时不误清未读，切回可见后清除', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const state = create()
    state.sessionId.value = 1
    await nextTick()
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    state.sessions.value = [{ id: 1, title: '合成对话', lastAssistantId: 20 }]
    await nextTick()
    expect(state.badges.value[1]).toBe('unread')
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    expect(state.badges.value).toEqual({})
  })

  it('IM 会话不参与运行或未读，也不写入已读缓存', async () => {
    const state = create([{ id: 2, title: '合成 QQ', source: 'qq', isRunning: true, lastAssistantId: 20 }])
    await nextTick()
    expect(state.badges.value).toEqual({})
    expect(localStorage.getItem('gugu:web-session-read:v1:synthetic-a')).toBe('{}')
  })

  it('改名或用户消息更新不产生未读；账号切换不继承旧账号未读', async () => {
    const state = create()
    state.sessions.value = [{ id: 1, title: '新标题', lastAssistantId: 10 }]
    await nextTick()
    expect(state.badges.value).toEqual({})
    state.sessions.value = [{ id: 1, title: '新标题', lastAssistantId: 20 }]
    await nextTick()
    expect(state.badges.value[1]).toBe('unread')
    state.accountId.value = 'synthetic-b'
    await nextTick()
    expect(state.badges.value).toEqual({})
    expect(localStorage.getItem('gugu:web-session-read:v1:synthetic-b')).toBeNull()
    state.sessions.value = [{ id: 2, title: '新账号对话', lastAssistantId: 40 }]
    await nextTick()
    expect(JSON.parse(localStorage.getItem('gugu:web-session-read:v1:synthetic-b')!)).toEqual({ 2: 40 })
  })

  it('旧接口缺少版本时不能建立零基线，首次有效响应将历史标为已读', async () => {
    const state = create([{ id: 1, title: '旧会话' }])
    await nextTick()
    expect(JSON.parse(localStorage.getItem('gugu:web-session-read:v1:synthetic-a')!)).toEqual({})
    state.sessions.value = [{ id: 1, title: '旧会话', lastAssistantId: 100 }]
    await nextTick()
    expect(state.badges.value).toEqual({})
    state.sessions.value = [{ id: 1, title: '旧会话', lastAssistantId: 101 }]
    await nextTick()
    expect(state.badges.value[1]).toBe('unread')
  })

  it('迁移旧版错误零基线，不把全部历史会话变成未读', async () => {
    localStorage.setItem('gugu:web-session-read:synthetic-a', JSON.stringify({ 1: 0 }))
    const state = create([{ id: 1, title: '旧会话', lastAssistantId: 100 }])
    await nextTick()
    expect(state.badges.value).toEqual({})
    expect(localStorage.getItem('gugu:web-session-read:synthetic-a')).toBeNull()
  })
})
