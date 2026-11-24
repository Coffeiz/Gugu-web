export const THEME_PALETTES = Object.freeze(['cafe', 'neutral', 'red', 'blue', 'green'] as const)
export type ThemePalette = (typeof THEME_PALETTES)[number]

const palettes: Record<ThemePalette, { readonly light: string; readonly dark: string }> = {
  cafe: { light: '#715653', dark: '#be9d98' },
  neutral: { light: '#565b64', dark: '#c0c3c9' },
  red: { light: '#a66e73', dark: '#d0a1a4' },
  blue: { light: '#65789a', dark: '#9aaecd' },
  green: { light: '#718a7e', dark: '#a9c2b5' },
}

export function isThemePalette(value: unknown): value is ThemePalette {
  return typeof value === 'string' && Object.hasOwn(palettes, value)
}

/** 邮件等非浏览器渲染使用当前配色的主色。 */
export function themePaletteColor(palette: ThemePalette, theme: 'light' | 'dark'): string {
  return palettes[palette][theme]
}
/** 只接受当前用户界面提供的五种配色，未知值使用 Ink。 */
export function normalizeThemePalette(value: unknown): ThemePalette {
  return isThemePalette(value) ? value : 'neutral'
}
/** IM 渲染只读取账号的外观字段，兼容 Web 已保存的旧键名。 */
export function normalizeImChartAppearance(value: unknown) {
  const data = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const { theme } = data
  const mode: 'light' | 'dark' | 'system' = theme === 'dark' || theme === 'system' ? theme : 'light'
  return {
    theme: mode,
    themeFamily: (data.themeFamily ?? data.theme_family) === 'mono' ? 'mono' as const : 'glass' as const,
    palette: normalizeThemePalette(data.palette),
  }
}
