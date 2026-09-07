/**
 * 将诊断指标压缩为适合卡片展示的数量级；原始数值仍保留在 trace 数据中。
 * 采用 SI 风格单位，避免大输入量只显示为一串难读的 k 数值。
 */
export function formatCompactNumber(value: number | null | undefined, empty = '—'): string {
  if (value == null || !Number.isFinite(value)) return empty

  const absolute = Math.abs(value)
  const units = [
    { threshold: 1_000_000_000, suffix: 'G' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 1_000, suffix: 'k' },
  ]
  const unit = units.find(item => absolute >= item.threshold)
  if (!unit) return String(Math.round(value))

  const scaled = value / unit.threshold
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
  return `${Number(scaled.toFixed(digits))}${unit.suffix}`
}
