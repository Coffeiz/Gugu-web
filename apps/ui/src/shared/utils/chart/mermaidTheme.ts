export type MermaidThemeColors = {
  primaryColor: string
  primaryTextColor: string
  primaryBorderColor: string
  lineColor: string
  arrowheadColor: string
  edgeLabelBackground: string
  secondaryColor: string
  tertiaryColor: string
  clusterBkg: string
  clusterBorder: string
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
    'color-mix(in srgb, var(--action-primary) 15%, var(--mermaid-node-bg))',
    dark ? '#343434' : '#ffffff',
  )
  const clusterBkg = resolve('var(--mermaid-cluster-bg)', dark ? '#262626' : '#f2f2f2')
  const lineColor = resolve('var(--mermaid-line)', dark ? '#bdbdbd' : '#626262')
  const primaryBorderColor = resolve('var(--mermaid-border)', dark ? '#5b5b5b' : '#c2c2c2')
  const colors = {
    primaryColor,
    primaryTextColor: resolve('var(--mermaid-text)', dark ? '#f2f2f2' : '#292929'),
    primaryBorderColor,
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
    clusterBkg,
    clusterBorder: primaryBorderColor,
  }

  probe.remove()
  return colors
}
