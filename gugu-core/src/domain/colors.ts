export const PROJECT_COLOR_PRESETS = [
  'linear-gradient(135deg,#c8aa72,#b88060)',
  'linear-gradient(135deg,#8fbe8b,#7ab8a8)',
  'linear-gradient(135deg,#7ab8a8,#7ab8c8)',
  'linear-gradient(135deg,#7ab8c8,#7b7fb2)',
  'linear-gradient(135deg,#5e73b2,#7b7fb2)',
  'linear-gradient(135deg,#7b7fb2,#c4afc8)',
  'linear-gradient(135deg,#c4afc8,#b07090)',
  'linear-gradient(135deg,#be8b8f,#c8aa72)',
] as const
export const PROJECT_COLOR_KEYS = [
  'amber',
  'sage',
  'teal',
  'sky',
  'indigo',
  'lavender',
  'rose',
  'sunset',
] as const
export const DEFAULT_PROJECT_COLOR = PROJECT_COLOR_PRESETS[5]
export function projectColorValue(value: string | null): string | null {
  const index = PROJECT_COLOR_KEYS.indexOf(value as (typeof PROJECT_COLOR_KEYS)[number])
  return index < 0 ? value : PROJECT_COLOR_PRESETS[index]!
}
export function projectColorKey(value: string | null): string | null {
  const index = PROJECT_COLOR_PRESETS.indexOf(value as (typeof PROJECT_COLOR_PRESETS)[number])
  return index < 0 ? null : PROJECT_COLOR_KEYS[index]!
}
