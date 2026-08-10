export function extractAccent(colorStr: string | null | undefined) {
  const match = colorStr?.match(/#[0-9a-fA-F]{6}/)
  return match ? match[0] : '#7b7fb2'
}

export function hexAlpha(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export function capBg(hex: string, progress: number | undefined) {
  const base = hexAlpha(hex, 0.1)
  if (!progress) return base
  const fill = hexAlpha(hex, 0.32)
  return `linear-gradient(to right, ${fill} 0%, ${fill} ${progress}%, ${base} ${progress}%, ${base} 100%)`
}

export function darkenHex(hex: string, amount = 0.60) {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * amount)
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * amount)
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * amount)
  return `rgb(${r},${g},${b})`
}
