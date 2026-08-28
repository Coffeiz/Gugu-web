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

  it('主题状态在初始化时读取，避免入口版本门之后仍使用旧缓存', async () => {
    installMatchMedia()
    const { initializeTheme, useTheme } = await import('./useTheme')

    localStorage.setItem('gugu-theme', 'dark')
    localStorage.setItem('gugu-theme-family', 'mono')
    localStorage.setItem('gugu-palette', 'teal')
    initializeTheme()

    expect(useTheme().preference.value).toBe('dark')
    expect(useTheme().family.value).toBe('mono')
    expect(useTheme().palette.value).toBe('sage')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.family).toBe('mono')
    expect(document.documentElement.dataset.palette).toBe('sage')
  })

  it('切换主题家族会持久化并更新根节点属性', async () => {
    installMatchMedia()
    const { initializeTheme, useTheme } = await import('./useTheme')
    initializeTheme()

    useTheme().setFamily('mono')

    expect(localStorage.getItem('gugu-theme-family')).toBe('mono')
    expect(document.documentElement.dataset.family).toBe('mono')
    expect(useTheme().family.value).toBe('mono')
  })

  it('旧 v2 偏好迁移为 Mono', async () => {
    installMatchMedia()
    localStorage.setItem('gugu-theme-family', 'v2')
    const { initializeTheme, useTheme } = await import('./useTheme')

    initializeTheme()

    expect(useTheme().family.value).toBe('mono')
    expect(document.documentElement.dataset.family).toBe('mono')
  })

  it('切换配色会持久化并更新根节点属性', async () => {
    installMatchMedia()
    const { initializeTheme, useTheme } = await import('./useTheme')
    initializeTheme()

    useTheme().setPalette('sky')

    expect(localStorage.getItem('gugu-palette')).toBe('sky')
    expect(document.documentElement.dataset.palette).toBe('sky')
    expect(useTheme().palette.value).toBe('sky')
  })

  it('非法配色回退为 Aero', async () => {
    installMatchMedia()
    localStorage.setItem('gugu-palette', 'unknown')
    const { initializeTheme, useTheme } = await import('./useTheme')

    initializeTheme()

    expect(useTheme().palette.value).toBe('aero')
    expect(document.documentElement.dataset.palette).toBe('aero')
  })
})
