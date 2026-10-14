export type MermaidThemeColors = {
  primaryColor: string
  primaryTextColor: string
  primaryBorderColor: string
  lineColor: string
  arrowheadColor: string
  edgeLabelBackground: string
  secondaryColor: string
  tertiaryColor: string
}

/** 从页面 CSS token 解析 Mermaid 配色，跟随当前主题和调色板。 */
export function resolveMermaidThemeColors(dark: boolean): MermaidThemeColors {
  const probe = document.createElement('span')
  const canvas = document.createElement('canvas')
  // 这里只把少量 CSS 颜色绘制到 1×1 画布并连续读回，启用读回优化以避免
  // Chromium 对频繁 getImageData 的性能警告和不必要的 GPU readback 开销。
  const context = canvas.getContext('2d', { willReadFrequently: true })
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.append(probe)

  const resolve = (value: string, fallback: string): string => {
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

  const primaryColor = resolve(
    'color-mix(in srgb, var(--color-primary) 15%, var(--surface-canvas-card))',
    dark ? '#382f31' : '#eee9e8',
  )
  const lineColor = resolve('var(--text-secondary)', dark ? '#c9c3d5' : '#67647a')
  const colors = {
    primaryColor,
    primaryTextColor: resolve('var(--text-primary)', dark ? '#f2eff7' : '#272532'),
    // 默认节点跟随用户当前配色的主色，而不是语义状态色或中性玻璃底色。
    primaryBorderColor: resolve(
      'var(--action-outline)',
      dark ? 'rgba(190, 157, 152, 0.34)' : 'rgba(113, 86, 83, 0.34)',
    ),
    lineColor,
    arrowheadColor: lineColor,
    edgeLabelBackground: primaryColor,
    secondaryColor: resolve(
      'color-mix(in srgb, var(--status-success) 45%, var(--surface-canvas-card))',
      dark ? '#344038' : '#edf3ef',
    ),
    tertiaryColor: resolve(
      'color-mix(in srgb, var(--status-warning) 45%, var(--surface-canvas-card))',
      dark ? '#453c31' : '#f4eee5',
    ),
  }

  probe.remove()
  return colors
}
