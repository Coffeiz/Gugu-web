// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { notifyLiveResourceChanged, RESOURCE_REFRESH_EVENTS } from '@/services/resourceRefreshEvents'

describe('跨端资源变更事件桥接', () => {
  it('Skill 实时事件会通知已打开的 Skill 页面重新加载', () => {
    const listener = vi.fn()
    window.addEventListener(RESOURCE_REFRESH_EVENTS.skills, listener)

    notifyLiveResourceChanged('skills')

    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener(RESOURCE_REFRESH_EVENTS.skills, listener)
  })

  it('无关资源不触发 Skill 页面刷新', () => {
    const listener = vi.fn()
    window.addEventListener(RESOURCE_REFRESH_EVENTS.skills, listener)

    notifyLiveResourceChanged('files')

    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(RESOURCE_REFRESH_EVENTS.skills, listener)
  })
})
