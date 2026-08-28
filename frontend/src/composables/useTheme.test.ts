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
    document.documentElement.removeAttribute('data-family')
    document.documentElement.removeAttribute('data-palette')
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

  it('切换主题家族会持久化并更新根节点属性', async () => {
    installMatchMedia()
    const { initializeTheme, useTheme } = await import('./useTheme')
    initializeTheme()

    useTheme().setFamily('v2')

    expect(localStorage.getItem('gugu-theme-family')).toBe('v2')
    expect(document.documentElement.dataset.family).toBe('v2')
    expect(useTheme().family.value).toBe('v2')
  })

  it('切换配色会持久化并更新根节点属性', async () => {
    installMatchMedia()
    const { initializeTheme, useTheme } = await import('./useTheme')
    initializeTheme()

    useTheme().setPalette('ocean')

    expect(localStorage.getItem('gugu-palette')).toBe('ocean')
    expect(document.documentElement.dataset.palette).toBe('ocean')
    expect(useTheme().palette.value).toBe('ocean')
  })

  it('非法配色回退为 Lavender', async () => {
    installMatchMedia()
    localStorage.setItem('gugu-palette', 'unknown')
    const { initializeTheme, useTheme } = await import('./useTheme')

    initializeTheme()

    expect(useTheme().palette.value).toBe('lavender')
    expect(document.documentElement.dataset.palette).toBe('lavender')
  })
})
