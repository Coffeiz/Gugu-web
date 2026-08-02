/**
 * 项目预设色板：唯一数据源。新建/编辑弹窗、Store 兜底默认值都从这里引用，
 * 不再各自维护一份色值列表——后端 backend/app/core/project_colors.py 是同一份
 * 色板的后端副本，改配色时两边要一起改。
 */
export const PROJECT_COLOR_PRESETS: readonly string[] = [
  'linear-gradient(135deg,#c8aa72,#b88060)',
  'linear-gradient(135deg,#8fbe8b,#7ab8a8)',
  'linear-gradient(135deg,#7ab8a8,#7ab8c8)',
  'linear-gradient(135deg,#7ab8c8,#7b7fb2)',
  'linear-gradient(135deg,#5e73b2,#7b7fb2)',
  'linear-gradient(135deg,#7b7fb2,#c4afc8)',
  'linear-gradient(135deg,#c4afc8,#b07090)',
  'linear-gradient(135deg,#be8b8f,#c8aa72)',
]

export const DEFAULT_PROJECT_COLOR: string = PROJECT_COLOR_PRESETS[5]

/** 从渐变或普通颜色配置中提取项目 accent 色。 */
export function extractProjectAccent(color: string | undefined): string {
  const match = color?.match(/#[0-9a-fA-F]{6}/)
  return match ? match[0] : '#7b7fb2'
}

/** 根据项目 accent 色生成轻量背景色。 */
export function projectAccentBackground(color: string): string {
  const hex = color.replace(/^#/, '')
  const channels = hex.match(/.{2}/g)
  if (!channels || channels.length < 3) return 'rgba(123,127,178,0.12)'
  const [red, green, blue] = channels.map(channel => parseInt(channel, 16))
  return `rgba(${red},${green},${blue},0.12)`
}
