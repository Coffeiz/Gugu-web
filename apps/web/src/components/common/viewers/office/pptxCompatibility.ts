const DRAWING_ML_NAMESPACE = 'http://schemas.openxmlformats.org/drawingml/2006/main'

function normalizeAdjustmentGuide(guide: Element): boolean {
  if (guide.getAttribute('name') !== 'adj') return false
  const match = /^val\s+(-?\d+)$/.exec(guide.getAttribute('fmla') ?? '')
  if (!match) return false

  // OOXML adjustment values for roundRect are in 0..50000. Some generators
  // write pixel-like values (for example 3996000); the renderer treats that
  // as a multiplier and draws giant arcs across the slide.
  const value = Number(match[1])
  const normalized = Math.max(0, Math.min(50_000, value))
  if (normalized === value) return false
  guide.setAttribute('fmla', `val ${normalized}`)
  return true
}

function normalizeRoundRect(geometry: Element): boolean {
  if (geometry.getAttribute('prst') !== 'roundRect') return false
  return Array.from(geometry.getElementsByTagNameNS(DRAWING_ML_NAMESPACE, 'gd'))
    .reduce((changed, guide) => normalizeAdjustmentGuide(guide) || changed, false)
}

function normalizeXmlPart(xml: string, parser: DOMParser, serializer: XMLSerializer): string | null {
  const document = parser.parseFromString(xml, 'application/xml')
  if (document.getElementsByTagName('parsererror').length) return null
  const changed = Array.from(document.getElementsByTagNameNS(DRAWING_ML_NAMESPACE, 'prstGeom'))
    .reduce((updated, geometry) => normalizeRoundRect(geometry) || updated, false)
  return changed ? serializer.serializeToString(document) : null
}

// 修正少数 PPTX 生成器写入的非标准圆角参数，避免形状弧线覆盖整页。
export function normalizePptxRoundRectAdjustments(parts: Array<Map<string, string>>) {
  const parser = new DOMParser()
  const serializer = new XMLSerializer()
  for (const part of parts) {
    for (const [path, xml] of part) {
      const normalized = normalizeXmlPart(xml, parser, serializer)
      if (normalized !== null) part.set(path, normalized)
    }
  }
}
