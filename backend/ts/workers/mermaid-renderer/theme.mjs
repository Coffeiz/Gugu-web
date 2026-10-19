export const MERMAID_NEUTRAL_THEME_COLORS = Object.freeze({
  background: '#ffffff',
  primaryColor: '#eee9e8',
  primaryTextColor: '#272532',
  primaryBorderColor: 'rgba(113, 86, 83, 0.34)',
  lineColor: '#67647a',
  arrowheadColor: '#67647a',
  edgeLabelBackground: '#eee9e8',
  secondaryColor: '#edf3ef',
  tertiaryColor: '#f4eee5',
})

const EDGE_LABEL_RADIUS_PX = 8

const PALETTE_COLORS = Object.freeze({
  mist: {
    light: { primary: '#7b7fb2', success: '#5a9e88', warning: '#b07858', info: '#6f9eaa' },
    dark: { primary: '#9590c4', success: '#80b4a2', warning: '#cea07f', info: '#8bc7d6' },
  },
  cafe: {
    light: { primary: '#715653', success: '#5e8877', warning: '#917451', info: '#647d8a' },
    dark: { primary: '#be9d98', success: '#92b9a7', warning: '#c5a77f', info: '#a1b9c5' },
  },
  rose: {
    light: { primary: '#b17e86', success: '#89a58e', warning: '#b39a75', info: '#7f9eaa' },
    dark: { primary: '#d8aeb5', success: '#abc8b0', warning: '#d1b88d', info: '#a7c4cf' },
  },
  sky: {
    light: { primary: '#738bb0', success: '#84a598', warning: '#ae9977', info: '#708faf' },
    dark: { primary: '#abc0d8', success: '#a9c8b6', warning: '#cfb88e', info: '#a3c5da' },
  },
  sage: {
    light: { primary: '#74968b', success: '#789d8c', warning: '#ad9977', info: '#709da4' },
    dark: { primary: '#aacabd', success: '#a6c9b5', warning: '#ceb88e', info: '#9fcfd0' },
  },
})

const FAMILY_COLORS = Object.freeze({
  glass: {
    light: { canvas: '#eef0f6', imageBackground: '#fcfcfd', text: '#1e2028', secondaryText: '#747985' },
    dark: { canvas: '#181b2c', imageBackground: '#1e2133', text: 'rgba(255, 255, 255, 0.92)', secondaryText: 'rgba(255, 255, 255, 0.62)' },
  },
  mono: {
    light: { canvas: '#f7f5f8', imageBackground: '#fbfafc', text: '#29262e', secondaryText: '#6f6975' },
    dark: { canvas: '#201d25', imageBackground: '#24212a', text: '#f0edf3', secondaryText: '#aaa3af' },
  },
})

function parseColor(color) {
  const hex = color.match(/^#([\da-f]{6})$/i)
  if (hex) {
    const value = hex[1]
    return {
      channels: [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16)),
      alpha: 1,
    }
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+)%?\s*)?\)$/i)
  if (!rgb) throw new Error('unsupported_theme_color')
  return {
    channels: rgb.slice(1, 4).map(Number),
    alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) / (color.includes('%') ? 100 : 1),
  }
}

function mixColors(foreground, background, amount) {
  const front = parseColor(foreground)
  const back = parseColor(background)
  const frontWeight = amount * front.alpha
  const backWeight = (1 - amount) * back.alpha
  const alpha = frontWeight + backWeight
  const channels = front.channels.map((channel, index) => Math.round(
    (channel * frontWeight + back.channels[index] * backWeight) / alpha,
  ))
  return alpha >= 0.999 ? `rgb(${channels.join(', ')})` : `rgba(${channels.join(', ')}, ${Number(alpha.toFixed(3))})`
}

function toRgba(color, alpha) {
  const [red, green, blue] = parseColor(color).channels
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function resolveCanvasColor(palette, family, mode) {
  const familyColors = FAMILY_COLORS[family]
  if (family !== 'glass' || palette === 'mist') return familyColors[mode].canvas

  // glass 的非默认配色改用 material-composition.css：面板底色由 palette-surface
  // 派生。保持和 Web 的 --surface-canvas-card 一致，避免 Mermaid 色阶继续混入旧蓝灰底。
  const paletteSurface = mode === 'dark'
    ? mixColors(palette[mode].primary, '#1e2133', 0.05)
    : mixColors(palette[mode].primary, '#ffffff', 0.05)
  return mode === 'dark'
    ? mixColors(paletteSurface, '#121424', 0.86)
    : mixColors(paletteSurface, '#ffffff', 0.9)
}

/** IM 使用账号已保存的显示主题，按与 Web CSS token 相同的混色比例生成图表颜色。 */
export function resolveMermaidThemeColors(preferences = {}) {
  const palette = PALETTE_COLORS[preferences.palette] || PALETTE_COLORS.mist
  const familyName = Object.hasOwn(FAMILY_COLORS, preferences.themeFamily) ? preferences.themeFamily : 'glass'
  const family = FAMILY_COLORS[familyName]
  const mode = preferences.theme === 'dark' ? 'dark' : 'light'
  const paletteColors = palette[mode]
  const familyColors = family[mode]
  const canvasColor = resolveCanvasColor(palette, familyName, mode)
  const primaryColor = mixColors(paletteColors.primary, canvasColor, 0.15)
  // Web 对非 café 调色板的状态色会混入 18% 次级文字色；IM 复用同一条规则，
  // 这样 Mermaid 自动生成的状态色阶不会比页面上的状态标记更鲜艳。
  const successColor = preferences.palette === 'cafe'
    ? paletteColors.success
    : mixColors(paletteColors.success, familyColors.secondaryText, 0.82)
  const warningColor = preferences.palette === 'cafe'
    ? paletteColors.warning
    : mixColors(paletteColors.warning, familyColors.secondaryText, 0.82)
  // Mermaid 分组底色属于结构层级，使用不同色相的浅辅色；警告色留给状态和第三色阶。
  const clusterBackground = mixColors(paletteColors.info, canvasColor, 0.05)
  const tertiaryBackground = mixColors(warningColor, canvasColor, 0.45)
  const lineColor = familyColors.secondaryText

  return {
    // Web 的 SVG 透明并显示在 surface-card-solid 上；IM PNG 使用同等的
    // 近白/深色卡片底，避免把整张图铺成页面画布色。
    background: familyColors.imageBackground,
    primaryColor,
    primaryTextColor: familyColors.text,
    primaryBorderColor: toRgba(paletteColors.primary, 0.34),
    lineColor,
    arrowheadColor: lineColor,
    edgeLabelBackground: primaryColor,
    secondaryColor: mixColors(successColor, canvasColor, 0.45),
    tertiaryColor: tertiaryBackground,
    clusterBkg: clusterBackground,
    clusterBorder: toRgba(paletteColors.primary, 0.34),
  }
}

/** Web 与 IM 共用的 Mermaid 布局、分组和标签样式。 */
export function createMermaidThemeConfig(colors, fontFamily) {
  return {
    layout: 'dagre',
    look: 'classic',
    theme: 'base',
    htmlLabels: false,
    themeCSS: [
      '.node rect { rx: 12px; }',
      '.nodeLabel, .edgeLabel { font-weight: 500; }',
      `.edgeLabel .background { rx: ${EDGE_LABEL_RADIUS_PX}px; ry: ${EDGE_LABEL_RADIUS_PX}px; opacity: 1; fill: ${colors.edgeLabelBackground}; stroke: ${colors.primaryBorderColor}; stroke-width: 1px; }`,
    ].join('\n'),
    themeVariables: {
      ...colors,
      // Flowchart 节点使用 nodeTextColor，而不是所有图表都直接读取 primaryTextColor。
      // 显式同步可避免自定义 classDef 节点回退到 Mermaid 默认深色文字。
      nodeTextColor: colors.primaryTextColor,
      textColor: colors.primaryTextColor,
      fontFamily,
    },
  }
}
