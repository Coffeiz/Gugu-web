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
    light: { primary: '#7b7fb2', success: '#5a9e88', warning: '#b07858' },
    dark: { primary: '#9590c4', success: '#80b4a2', warning: '#cea07f' },
  },
  cafe: {
    light: { primary: '#715653', success: '#5e8877', warning: '#917451' },
    dark: { primary: '#be9d98', success: '#92b9a7', warning: '#c5a77f' },
  },
  rose: {
    light: { primary: '#b17e86', success: '#89a58e', warning: '#b39a75' },
    dark: { primary: '#d8aeb5', success: '#abc8b0', warning: '#d1b88d' },
  },
  sky: {
    light: { primary: '#738bb0', success: '#84a598', warning: '#ae9977' },
    dark: { primary: '#abc0d8', success: '#a9c8b6', warning: '#cfb88e' },
  },
  sage: {
    light: { primary: '#74968b', success: '#789d8c', warning: '#ad9977' },
    dark: { primary: '#aacabd', success: '#a6c9b5', warning: '#ceb88e' },
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

function parseHex(color) {
  const value = color.replace('#', '')
  return [0, 2, 4].map(index => Number.parseInt(value.slice(index, index + 2), 16))
}

function mixColors(foreground, background, amount) {
  const front = parseHex(foreground)
  const back = parseHex(background)
  const rgb = front.map((channel, index) => Math.round(channel * amount + back[index] * (1 - amount)))
  return `rgb(${rgb.join(', ')})`
}

function toRgba(color, alpha) {
  const [red, green, blue] = parseHex(color)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

/** IM 使用账号已保存的显示主题，按与 Web CSS token 相同的混色比例生成图表颜色。 */
export function resolveMermaidThemeColors(preferences = {}) {
  const palette = PALETTE_COLORS[preferences.palette] || PALETTE_COLORS.mist
  const family = FAMILY_COLORS[preferences.themeFamily] || FAMILY_COLORS.glass
  const mode = preferences.theme === 'dark' ? 'dark' : 'light'
  const paletteColors = palette[mode]
  const familyColors = family[mode]
  const primaryColor = mixColors(paletteColors.primary, familyColors.canvas, 0.15)
  const clusterBackground = mixColors(paletteColors.warning, familyColors.canvas, 0.45)
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
    secondaryColor: mixColors(paletteColors.success, familyColors.canvas, 0.45),
    tertiaryColor: clusterBackground,
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
      fontFamily,
    },
  }
}
