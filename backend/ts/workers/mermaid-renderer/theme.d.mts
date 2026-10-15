export type MermaidThemeColors = {
  background?: string
  primaryColor: string
  primaryTextColor: string
  primaryBorderColor: string
  lineColor: string
  arrowheadColor: string
  edgeLabelBackground: string
  secondaryColor: string
  tertiaryColor: string
  clusterBkg?: string
  clusterBorder?: string
}

export const MERMAID_NEUTRAL_THEME_COLORS: Readonly<MermaidThemeColors>

export function resolveMermaidThemeColors(preferences?: {
  theme?: 'light' | 'dark' | 'system'
  themeFamily?: 'glass' | 'mono'
  palette?: 'mist' | 'cafe' | 'rose' | 'sky' | 'sage'
}): MermaidThemeColors & { clusterBkg: string; clusterBorder: string }

export function createMermaidThemeConfig(
  colors: MermaidThemeColors,
  fontFamily: string,
): {
  layout: 'dagre'
  look: 'classic'
  theme: 'base'
  htmlLabels: false
  themeCSS: string
  themeVariables: MermaidThemeColors & { fontFamily: string }
}
