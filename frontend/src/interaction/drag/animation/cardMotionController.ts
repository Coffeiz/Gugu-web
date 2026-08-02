import { integrateSpring } from '../core/physics'
import type { MotionProfile } from './motionProfiles'

/**
 * 单代理卡片的连续运动状态机——见 docs/refactor/拖拽系统模块化拆分方案.md 2.3 节。
 *
 * 位置和缩放都走同一个 rAF 循环、同一份弹簧状态，`setTarget()` 只更新目标点，
 * 不重启、不重置速度——这是"松手到落地是一条连续轨迹"的物理保证，不是靠外部
 * 手动拼接初速度。
 *
 * 两种运行模式（2.3.6 第三步新增 'follow'）：
 * - 'settle'（默认）：落地场景，目标点最终会稳定，到达阈值内自动停止并触发一次
 *   onArrived；旋转是指数衰减到 0（对应 springTo 迁移前的行为，见下方旧注释）。
 * - 'follow'：拖拽跟手场景，目标点随指针持续变化，永远不会真正"到达"，不检测
 *   阈值、不触发 onArrived、不自动停止——只能靠外部显式 stop()。旋转不是衰减，
 *   是照抄 legacy single.ts frame() 的公式：用位置速度做一次低通平滑（时间常数
 *   固定，跟 legacy 的 KV 一致，不开放自定义——legacy 从来没让这个参数可调），
 *   再分别映射成 rotateZ（横向摆动）和 rotateX（纵向后仰），跟落地阶段的衰减
 *   是两套完全不同的旋转模型，不能合并成一套参数。
 */

export interface MotionVector {
  x: number
  y: number
}

export interface MotionState {
  x: number
  y: number
  vx: number
  vy: number
  scaleX: number
  scaleY: number
  scaleVX: number
  scaleVY: number
  rotateX: number
  rotateZ: number
}

export interface MotionTarget {
  x: number
  y: number
  scaleX?: number
  scaleY?: number
}

export interface MotionFrame {
  x: number
  y: number
  scaleX: number
  scaleY: number
  rotateX: number
  rotateZ: number
}

export interface ArriveThreshold {
  position: number
  velocity: number
}

/** 'follow' 模式下用速度算摆动/后仰角的参数——原样对应 legacy single.ts 的 SWAY/TILT/GRABY 手感常量。 */
export interface FollowRotationConfig {
  /** 基准后仰角(deg)，legacy 的 TILT。 */
  tilt: number
  /** 横向摆动系数，legacy 的 SWAY。 */
  sway: number
  /** rotateZ 摆动的 clamp 范围(deg)，legacy 固定写死 5。 */
  maxSway?: number
  /** rotateX 在 tilt 基准上下浮动的 clamp 范围(deg)，legacy 固定写死 4。 */
  maxTiltDelta?: number
  /** 纵向速度到 rotateX 增量的映射系数，legacy 固定写死 0.16。 */
  verticalTiltFactor?: number
}

export interface CardMotionControllerOptions {
  onFrame: (frame: MotionFrame) => void
  onArrived?: () => void
  arriveThreshold?: ArriveThreshold
  /** 默认 'settle'——见文件头注释，两种模式的旋转模型和到达语义完全不同。 */
  mode?: 'settle' | 'follow'
  /** mode: 'follow' 时必填。 */
  followRotation?: FollowRotationConfig
}

export interface CardMotionController {
  /** 设定运动状态的起点，只应在 start() 之前调用一次；不是"跳变目标"。 */
  seed(partial: Partial<MotionState>): void
  setTarget(target: MotionTarget): void
  setProfile(profile: MotionProfile): void
  getState(): Readonly<MotionState>
  start(): void
  stop(): void
}

const DEFAULT_ARRIVE: ArriveThreshold = { position: 0.35, velocity: 5 }
// legacy single.ts frame() 里的低通平滑时间常数，从来不是可调参数——原样保留同一个数。
const FOLLOW_VELOCITY_SMOOTHING_RATE = -Math.log(1 - 0.12) * 60

export function createCardMotionController(options: CardMotionControllerOptions): CardMotionController {
  const mode = options.mode ?? 'settle'
  if (mode === 'follow' && !options.followRotation) {
    throw new Error('CardMotionController: mode "follow" 需要提供 followRotation 参数')
  }
  const arrive = options.arriveThreshold ?? DEFAULT_ARRIVE

  const state: MotionState = {
    x: 0, y: 0, vx: 0, vy: 0,
    scaleX: 1, scaleY: 1, scaleVX: 0, scaleVY: 0,
    rotateX: 0, rotateZ: 0,
  }
  let target: MotionTarget = { x: 0, y: 0 }
  let profile: MotionProfile = { position: { stiffness: 420, damping: 30 }, scale: { stiffness: 420, damping: 30 } }
  let raf: number | null = null
  let lastTime: number | null = null
  let running = false
  // 'follow' 模式对速度做的低通平滑状态——只用来算旋转，不是 MotionState 的一部分
  // （旋转以外没有别的地方需要读这份平滑过的速度）。
  let smoothedVX = 0
  let smoothedVY = 0

  function tick(time: number) {
    if (!running) return
    const dt = Math.min(0.032, lastTime == null ? 1 / 60 : (time - lastTime) / 1000)
    lastTime = time

    const posState = { position: { x: state.x, y: state.y }, velocity: { x: state.vx, y: state.vy } }
    integrateSpring(posState, { x: target.x, y: target.y }, profile.position.stiffness, profile.position.damping, dt)
    state.x = posState.position.x
    state.y = posState.position.y
    state.vx = posState.velocity.x
    state.vy = posState.velocity.y

    const targetScaleX = target.scaleX ?? state.scaleX
    const targetScaleY = target.scaleY ?? state.scaleY
    const scaleState = { position: { x: state.scaleX, y: state.scaleY }, velocity: { x: state.scaleVX, y: state.scaleVY } }
    integrateSpring(scaleState, { x: targetScaleX, y: targetScaleY }, profile.scale.stiffness, profile.scale.damping, dt)
    state.scaleX = scaleState.position.x
    state.scaleY = scaleState.position.y
    state.scaleVX = scaleState.velocity.x
    state.scaleVY = scaleState.velocity.y

    if (mode === 'follow') {
      const rotation = options.followRotation!
      const maxSway = rotation.maxSway ?? 5
      const maxTiltDelta = rotation.maxTiltDelta ?? 4
      const verticalTiltFactor = rotation.verticalTiltFactor ?? 0.16
      const smoothing = 1 - Math.exp(-FOLLOW_VELOCITY_SMOOTHING_RATE * dt)
      smoothedVX += (state.vx - smoothedVX) * smoothing
      smoothedVY += (state.vy - smoothedVY) * smoothing
      state.rotateZ = Math.max(-maxSway, Math.min(maxSway, (smoothedVX / 60) * rotation.sway))
      state.rotateX = rotation.tilt + Math.max(-maxTiltDelta, Math.min(maxTiltDelta, (smoothedVY / 60) * verticalTiltFactor))
    } else {
      const rotationDecay = Math.exp(-10 * dt)
      state.rotateX *= rotationDecay
      state.rotateZ *= rotationDecay
    }

    options.onFrame({
      x: state.x, y: state.y,
      scaleX: state.scaleX, scaleY: state.scaleY,
      rotateX: state.rotateX, rotateZ: state.rotateZ,
    })

    if (mode === 'follow') {
      // 'follow' 模式的目标点会持续随指针变化，永远不会真正"到达"——不检测阈值，
      // 只能靠外部显式 stop()（比如松手切换到 landing 阶段）。
      raf = requestAnimationFrame(tick)
      return
    }

    const arrived = Math.abs(target.x - state.x) < arrive.position
      && Math.abs(target.y - state.y) < arrive.position
      && Math.abs(state.vx) < arrive.velocity
      && Math.abs(state.vy) < arrive.velocity
    if (arrived) {
      running = false
      options.onArrived?.()
      return
    }
    raf = requestAnimationFrame(tick)
  }

  return {
    seed(partial) {
      Object.assign(state, partial)
    },
    setTarget(next) {
      target = next
    },
    setProfile(next) {
      profile = next
    },
    getState() {
      return state
    },
    start() {
      if (running) return
      running = true
      lastTime = null
      // 立刻把当前（seed 好的）状态回调一次，不等第一次 rAF——legacy 的 frame()/
      // visual.update() 在拾起的同一时刻就同步写过一次 transform，代理刚出现就带着
      // tilt/位置，不会有一帧空白。注意这里不能直接同步调用 tick()：tick() 需要一个
      // 跟后续 rAF 回调时间戳同源的 time 参数，这里手头只有 performance.now()，
      // 在假定时器（vi.useFakeTimers）环境下这个时间基准跟 requestAnimationFrame
      // mock 出来的时间基准不是一回事，直接喂给 tick() 会把 dt 算成一个巨大的
      // 错误值——只回放当前状态、不推进物理，就不会有这个问题。
      options.onFrame({
        x: state.x, y: state.y,
        scaleX: state.scaleX, scaleY: state.scaleY,
        rotateX: state.rotateX, rotateZ: state.rotateZ,
      })
      raf = requestAnimationFrame(tick)
    },
    stop() {
      running = false
      if (raf !== null) {
        cancelAnimationFrame(raf)
        raf = null
      }
    },
  }
}
