import { describe, expect, it } from 'vitest'
import { resolveProjectDropStatus } from '@/utils/projectDrop'

const columns = [
  { status: 'pending', left: 0, right: 300 },
  { status: 'active', left: 320, right: 620 },
  { status: 'done', left: 640, right: 940 },
]

describe('resolveProjectDropStatus', () => {
  it('忽略纵向位置：列底部空白仍归属该状态列', () => {
    expect(resolveProjectDropStatus(columns, { pointerX: 450, pointerVelocityX: 0, isLandingRegrab: false })).toBe('active')
  })

  it('落地途中重抓只认本次松手列，不继承上一段动画的速度', () => {
    expect(resolveProjectDropStatus(columns, { pointerX: 450, pointerVelocityX: -1800, isLandingRegrab: true })).toBe('active')
  })

  it('普通抛出只沿鼠标运动方向前探，不会反向拉回已进入的列', () => {
    expect(resolveProjectDropStatus(columns, { pointerX: 450, pointerVelocityX: 1800, isLandingRegrab: false })).toBe('active')
    expect(resolveProjectDropStatus(columns, { pointerX: 450, pointerVelocityX: -1800, isLandingRegrab: false })).toBe('pending')
  })

  it('指针落在列外时不改变状态', () => {
    expect(resolveProjectDropStatus(columns, { pointerX: 310, pointerVelocityX: 0, isLandingRegrab: false })).toBeNull()
  })
})
