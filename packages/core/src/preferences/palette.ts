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
