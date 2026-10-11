export type MermaidThemeColors = {
  primaryColor: string
  primaryTextColor: string
  primaryBorderColor: string
  lineColor: string
  secondaryColor: string
  tertiaryColor: string
}

/** 将 CSS 主题颜色解析成 Mermaid 色彩解析器支持的 rgb() 值。 */
export function resolveMermaidThemeColors(dark: boolean): MermaidThemeColors {
  const root = document.documentElement
  const probe = document.createElement('span')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.append(probe)

  const resolve = (token: string, fallback: string): string => {
    const value = getComputedStyle(root).getPropertyValue(token).trim() || fallback
    probe.style.color = value
    const computed = getComputedStyle(probe).color
    if (!context) return fallback

    context.clearRect(0, 0, 1, 1)
    context.fillStyle = computed
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    return alpha === 255
      ? `rgb(${red}, ${green}, ${blue})`
      : `rgba(${red}, ${green}, ${blue}, ${Number((alpha / 255).toFixed(3))})`
  }

  const colors = {
    primaryColor: resolve('--surface-card-solid', dark ? '#24212b' : '#ffffff'),
    primaryTextColor: resolve('--text-primary', dark ? '#f2eff7' : '#272532'),
    primaryBorderColor: resolve('--border-default', dark ? 'rgba(255,255,255,.16)' : 'rgba(42,35,49,.12)'),
    lineColor: resolve('--text-secondary', dark ? '#c9c3d5' : '#67647a'),
    secondaryColor: resolve('--surface-panel', dark ? '#2c2835' : '#f3f2f7'),
    tertiaryColor: resolve('--surface-hover', dark ? '#363140' : '#ebeaf2'),
  }

  probe.remove()
  return colors
}
