/** 项目弹窗提供的可选颜色。 */
export const PROJECT_COLOR_OPTIONS = [
  { key: 'amber', value: 'linear-gradient(135deg,#c8aa72,#b88060)' },
  { key: 'sage', value: 'linear-gradient(135deg,#8fbe8b,#7ab8a8)' },
  { key: 'teal', value: 'linear-gradient(135deg,#7ab8a8,#7ab8c8)' },
  { key: 'sky', value: 'linear-gradient(135deg,#7ab8c8,#7b7fb2)' },
  { key: 'indigo', value: 'linear-gradient(135deg,#5e73b2,#7b7fb2)' },
  { key: 'lavender', value: 'linear-gradient(135deg,#7b7fb2,#c4afc8)' },
  { key: 'rose', value: 'linear-gradient(135deg,#c4afc8,#b07090)' },
] as const

export const SELECTABLE_PROJECT_COLORS = PROJECT_COLOR_OPTIONS.map(option => option.value)
export const NOTE_COLOR_OPTIONS = PROJECT_COLOR_OPTIONS.map(({ key, value }) => ({
  key, color: `project:${key}`, background: key === 'amber' ? '#cda370' : extractProjectAccent(value),
}))
export const DEFAULT_CANVAS_NOTE_COLOR = NOTE_COLOR_OPTIONS[0].color

export function notePaletteOption(color: string | null | undefined) {
  return NOTE_COLOR_OPTIONS.find(option => option.color === color)
}

export function notePaletteAccent(color: string | null | undefined): string | undefined {
  return notePaletteOption(color)?.background
}

export const PROJECT_COLOR_PRESETS: readonly string[] = SELECTABLE_PROJECT_COLORS

export const DEFAULT_PROJECT_COLOR: string = PROJECT_COLOR_PRESETS[5]

/** 从渐变或普通颜色配置中提取项目 accent 色。 */
export function extractProjectAccent(color: string | null | undefined): string {
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

export const PROJECT_STATUS_COLORS: Readonly<Record<string, string>> = { pending: '#d46b6b', active: '#c9943a', done: '#5a9e88' }
