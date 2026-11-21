export type RelationAnchorSide = 'left' | 'right' | 'top' | 'bottom'

export interface RelationPoint {
  x: number
  y: number
}

export interface RelationRect {
  x: number
  y: number
  w: number
  h: number
}

// 关系线和视口裁剪共用同一份曲率边界；不要在 RelationLayer/MindCanvas 各维护一个数字。
export const RELATION_CURVE_MIN_EXTEND = 35
export const RELATION_CURVE_MAX_EXTEND = 75

function extend(point: RelationPoint, side: RelationAnchorSide, distance: number): RelationPoint {
  if (side === 'left') return { x: point.x - distance, y: point.y }
  if (side === 'right') return { x: point.x + distance, y: point.y }
  if (side === 'top') return { x: point.x, y: point.y - distance }
  return { x: point.x, y: point.y + distance }
}

/**
 * 端点顺着各自卡片边法线先探出去一段，再用三次贝塞尔连起来。
 * 预览线和落定关系都调用这一份，避免两套曲率算法松手时跳形。
 */
export function relationCurvePath(
  from: RelationPoint,
  fromSide: RelationAnchorSide,
  to: RelationPoint,
  toSide: RelationAnchorSide,
): string {
  const distance = Math.min(
    Math.max(Math.hypot(to.x - from.x, to.y - from.y) * 0.3, RELATION_CURVE_MIN_EXTEND),
    RELATION_CURVE_MAX_EXTEND,
  )
  const c1 = extend(from, fromSide, distance)
  const c2 = extend(to, toSide, distance)
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`
}

/**
 * 关系线窗口化的保守包围盒。控制点最多只会向卡片外探 RELATION_CURVE_MAX_EXTEND，
 * 因此把两张端点卡的联合矩形向外扩这段距离即可保证：两端都离屏、但曲线中段仍穿过
 * 当前视口时，关系不会被误裁掉。这个盒会略微多保留少量斜线关系，但不会退化成全量渲染。
 */
export function relationEnvelope(a: RelationRect, b: RelationRect): RelationRect {
  const margin = RELATION_CURVE_MAX_EXTEND
  const left = Math.min(a.x, b.x) - margin
  const top = Math.min(a.y, b.y) - margin
  const right = Math.max(a.x + a.w, b.x + b.w) + margin
  const bottom = Math.max(a.y + a.h, b.y + b.h) + margin
  return { x: left, y: top, w: right - left, h: bottom - top }
}
