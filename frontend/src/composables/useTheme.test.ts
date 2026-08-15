import { afterEach, describe, expect, it, vi } from 'vitest'

function installMatchMedia(matches = false) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia
}

describe('主题令牌状态', () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    vi.resetModules()
  })

  it('切换主题会持久化偏好并更新根节点主题', async () => {
    installMatchMedia()
    const { useTheme, initializeTheme } = await import('./useTheme')
    initializeTheme()
    const theme = useTheme()

    theme.setTheme('dark')

    expect(localStorage.getItem('gugu-theme')).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(theme.resolved.value).toBe('dark')
  })

  it('system 偏好根据媒体查询解析，并注册变化监听', async () => {
    installMatchMedia(true)
    localStorage.setItem('gugu-theme', 'system')
    const { initializeTheme, useTheme } = await import('./useTheme')

    initializeTheme()

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(useTheme().preference.value).toBe('system')
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
  })
})
