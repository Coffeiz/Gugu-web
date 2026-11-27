export const MERMAID_NEUTRAL_THEME_COLORS = Object.freeze({
  background: '#ffffff',
  primaryColor: '#eff0f2',
  primaryTextColor: '#272a30',
  primaryBorderColor: 'rgba(86, 91, 100, 0.34)',
  lineColor: '#626771',
  arrowheadColor: '#626771',
  edgeLabelBackground: '#eff0f2',
  secondaryColor: '#edf1ee',
  tertiaryColor: '#f2efeb',
})

const EDGE_LABEL_RADIUS_PX = 8

const PALETTE_COLORS = Object.freeze({
  cafe: {
    light: { primary: '#715653', success: '#5e8877', warning: '#917451', info: '#647d8a' },
    dark: { primary: '#be9d98', success: '#92b9a7', warning: '#c5a77f', info: '#a1b9c5' },
  },
  neutral: {
    light: { primary: '#565b64', success: '#71877c', warning: '#9a8465', info: '#6f8794' },
    dark: { primary: '#c0c3c9', success: '#a3b9ad', warning: '#c8b48f', info: '#a3bfca' },
  },
  red: {
    light: { primary: '#a66e73', success: '#778a7d', warning: '#9a8465', info: '#718995' },
    dark: { primary: '#d0a1a4', success: '#a8bcae', warning: '#c9b48f', info: '#a5c0c9' },
  },
  blue: {
    light: { primary: '#65789a', success: '#718a7f', warning: '#988563', info: '#65789a' },
    dark: { primary: '#9aaecd', success: '#a4c1b1', warning: '#cbb790', info: '#9aaed2' },
  },
  green: {
    light: { primary: '#718a7e', success: '#718a7e', warning: '#978363', info: '#6d8990' },
    dark: { primary: '#a9c1b4', success: '#a9c1b4', warning: '#c9b58f', info: '#a3c2c8' },
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
  if (family !== 'glass' || palette === PALETTE_COLORS.neutral) return familyColors[mode].canvas

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
  const legacyPalettes = { mist: 'blue', rose: 'red', sky: 'blue', sage: 'green', lavender: 'blue', amber: 'neutral', aero: 'blue', mono: 'neutral', coral: 'red', teal: 'green' }
  const paletteName = PALETTE_COLORS[preferences.palette]
    ? preferences.palette
    : legacyPalettes[preferences.palette] || 'neutral'
  const palette = PALETTE_COLORS[paletteName]
  const familyName = Object.hasOwn(FAMILY_COLORS, preferences.themeFamily) ? preferences.themeFamily : 'glass'
  const family = FAMILY_COLORS[familyName]
  const mode = preferences.theme === 'dark' ? 'dark' : 'light'
  const paletteColors = palette[mode]
  const familyColors = family[mode]
  const canvasColor = resolveCanvasColor(palette, familyName, mode)
  const primaryColor = mixColors(paletteColors.primary, canvasColor, 0.15)
  // Web 对非 café 调色板的状态色会混入 18% 次级文字色；IM 复用同一条规则，
  // 这样 Mermaid 自动生成的状态色阶不会比页面上的状态标记更鲜艳。
  const successColor = paletteName === 'cafe'
    ? paletteColors.success
    : mixColors(paletteColors.success, familyColors.secondaryText, 0.82)
  const warningColor = paletteName === 'cafe'
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
