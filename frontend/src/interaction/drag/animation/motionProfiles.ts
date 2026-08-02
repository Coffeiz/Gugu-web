export interface SpringParams {
  stiffness: number
  damping: number
}

export interface MotionProfile {
  position: SpringParams
  scale: SpringParams
}

/** 跟手阶段的默认 profile；生产 adapter 会按 physicsTuning 覆盖。 */
export const DRAG_PROFILE: MotionProfile = {
  position: { stiffness: 360, damping: 32.3 },
  scale: { stiffness: 360, damping: 32.3 },
}

/** 落地阶段的默认弹簧参数——对应 CardProxy.springTo 迁移前的默认值（stiffness 420 / damping 30）。 */
export const LANDING_PROFILE: MotionProfile = {
  position: { stiffness: 420, damping: 30 },
  scale: { stiffness: 420, damping: 30 },
}
