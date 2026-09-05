import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('控制台横幅', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.documentElement.style.setProperty('--action-primary', '#7b7fb2')
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    document.documentElement.style.removeProperty('--action-primary')
  })

  it('主题切换不会重复追加横幅日志', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { startConsoleBanner } = await import('./consoleBanner')

    startConsoleBanner()
    vi.advanceTimersByTime(600)
    expect(info).toHaveBeenCalledTimes(3)

    document.documentElement.dataset.theme = 'dark'
    document.documentElement.dataset.palette = 'rose'
    vi.advanceTimersByTime(600)

    expect(info).toHaveBeenCalledTimes(3)
    info.mockRestore()
  })
})
