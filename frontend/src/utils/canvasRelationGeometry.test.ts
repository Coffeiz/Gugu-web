import { describe, expect, it } from 'vitest'
import { RELATION_CURVE_MAX_EXTEND, relationCurvePath, relationEnvelope } from './canvasRelationGeometry'

describe('canvas relation geometry', () => {
  it('keeps the corridor between far-apart endpoint cards inside the relation envelope', () => {
    const envelope = relationEnvelope(
      { x: -1200, y: 80, w: 240, h: 120 },
      { x: 1800, y: 120, w: 220, h: 96 },
    )

    expect(envelope.x).toBe(-1200 - RELATION_CURVE_MAX_EXTEND)
    expect(envelope.x + envelope.w).toBe(2020 + RELATION_CURVE_MAX_EXTEND)
    expect(envelope.y).toBe(80 - RELATION_CURVE_MAX_EXTEND)
    expect(envelope.y + envelope.h).toBe(216 + RELATION_CURVE_MAX_EXTEND)
  })

  it('uses the same bounded curve shape for preview and committed relations', () => {
    const path = relationCurvePath(
      { x: 0, y: 50 },
      'right',
      { x: 2000, y: 80 },
      'left',
    )

    // 远距离关系的控制点探出量封顶 75，不会随着距离无限增大。
    expect(path).toBe('M 0 50 C 75 50, 1925 80, 2000 80')
  })
})
