import { computed, onBeforeUnmount, ref } from 'vue'
import { clampScrubberPosition, detentPosition } from '../utils/dateScrubberMath'

type MotionPhase = 'idle' | 'dragging' | 'settling' | 'handoff'

interface DateScrubberMotionOptions {
  getCount: () => number
  onPosition: (position: number) => void
  onSettled: (index: number) => void
}

/**
 * 日期滑条的手势/弹簧状态机。
 *
 * `visualPosition` 是拖动和弹簧期间唯一的视觉真相；外部内容列的位置只在 idle 时接管。
 * 弹簧结束后进入 handoff，等待内容列实际追到目标位置再归还控制权，避免旧的 centerFrac
 * 滞后一帧把已吸附的滑条拉回去。
 */
export function useDateScrubberMotion(options: DateScrubberMotionOptions) {
  const visualPosition = ref(0)
  const phase = ref<MotionPhase>('idle')
  const dragging = computed(() => phase.value === 'dragging')
  const animating = computed(() => phase.value === 'settling')

  let pointerStartX = 0
  let positionAtStart = 0
  let pitchAtStart = 1
  let velocity = 0
  let lastMoveAt = 0
  let moved = false
  let rafId = 0
  let animationRun = 0
  let handoffTarget: number | null = null
  let handoffTimer: ReturnType<typeof setTimeout> | null = null

  function stopMotion() {
    animationRun += 1
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    if (handoffTimer) clearTimeout(handoffTimer)
    handoffTimer = null
    handoffTarget = null
    phase.value = 'idle'
  }

  function setPosition(position: number) {
    visualPosition.value = position
    options.onPosition(clampScrubberPosition(position, options.getCount()))
  }

  function begin(pointerX: number, pitch: number) {
    stopMotion()
    pointerStartX = pointerX
    positionAtStart = visualPosition.value
    pitchAtStart = Math.max(1, pitch)
    velocity = 0
    lastMoveAt = 0
    moved = false
    phase.value = 'dragging'
  }

  function move(pointerX: number, ratio: number) {
    if (phase.value !== 'dragging') return
    const delta = pointerX - pointerStartX
    if (Math.abs(delta) > 3) moved = true
    const next = detentPosition(positionAtStart - (delta * ratio) / pitchAtStart, options.getCount())
    const now = performance.now()
    const elapsed = lastMoveAt ? now - lastMoveAt : 16
    const instantVelocity = (next - visualPosition.value) / Math.max(elapsed, 4)
    velocity = velocity * 0.6 + instantVelocity * 0.4
    lastMoveAt = now
    setPosition(next)
  }

  function end(clickedIndex: number | null) {
    if (phase.value !== 'dragging') return
    const count = options.getCount()
    if (!count) return stopMotion()
    const last = count - 1
    const target = !moved && clickedIndex !== null
      ? clampScrubberPosition(clickedIndex, count)
      : Math.round(clampScrubberPosition(visualPosition.value + Math.max(-1.1, Math.min(1.1, velocity * 45)), count))
    settleTo(Math.min(last, target))
  }

  function settleTo(target: number) {
    const run = ++animationRun
    let position = visualPosition.value
    let springVelocity = 0
    let previousAt = performance.now()
    phase.value = 'settling'
    const frame = (now: number) => {
      if (run !== animationRun) return
      const elapsed = Math.min(1 / 30, Math.max(1 / 240, (now - previousAt) / 1000))
      previousAt = now
      springVelocity += (260 * (target - position) - 32 * springVelocity) * elapsed
      position += springVelocity * elapsed
      setPosition(position)
      if (Math.abs(target - position) > 0.002 || Math.abs(springVelocity) > 0.02) {
        rafId = requestAnimationFrame(frame)
        return
      }
      rafId = 0
      visualPosition.value = target
      options.onPosition(target)
      options.onSettled(target)
      handoffTarget = target
      phase.value = 'handoff'
      // 内容列有自己的阻尼，会晚于滑条到位；超时只防止被异常外部状态永久锁住。
      handoffTimer = setTimeout(() => {
        handoffTimer = null
        handoffTarget = null
        phase.value = 'idle'
      }, 700)
    }
    rafId = requestAnimationFrame(frame)
  }

  function syncExternal(position: number) {
    if (phase.value === 'idle') {
      visualPosition.value = position
      return
    }
    if (phase.value === 'handoff' && handoffTarget !== null && Math.abs(position - handoffTarget) < 0.04) {
      if (handoffTimer) clearTimeout(handoffTimer)
      handoffTimer = null
      handoffTarget = null
      phase.value = 'idle'
      visualPosition.value = position
    }
  }

  onBeforeUnmount(stopMotion)
  return { visualPosition, dragging, animating, begin, move, end, stopMotion, syncExternal }
}
