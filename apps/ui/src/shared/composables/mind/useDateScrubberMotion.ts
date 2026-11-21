import { computed, onBeforeUnmount, ref } from 'vue'
import { clampScrubberPosition, detentPosition } from '@/views/Mind/utils/dateScrubberMath'

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
  let moved = false
  const DRAG_SPRING = 360
  const DRAG_DAMPING = 38
  let dragTarget = 0
  let dragLastAt = 0
  let dragRaf = 0
  let rafId = 0
  let animationRun = 0
  let handoffTarget: number | null = null
  let handoffTimer: ReturnType<typeof setTimeout> | null = null

  function stopMotion() {
    animationRun += 1
    if (rafId) cancelAnimationFrame(rafId)
    if (dragRaf) cancelAnimationFrame(dragRaf)
    rafId = 0
    dragRaf = 0
    if (handoffTimer) clearTimeout(handoffTimer)
    handoffTimer = null
    handoffTarget = null
    phase.value = 'idle'
  }

  function setPosition(position: number) {
    visualPosition.value = position
    // 保留边界外的橡皮筋位置；内容列需要这段连续位移来同步自己的回弹。
    // 选中日期仍由消费者按边界裁剪，不能在这里提前丢掉视觉状态。
    options.onPosition(position)
  }

  function begin(pointerX: number, pitch: number) {
    stopMotion()
    pointerStartX = pointerX
    positionAtStart = visualPosition.value
    dragTarget = visualPosition.value
    pitchAtStart = Math.max(1, pitch)
    velocity = 0
    moved = false
    phase.value = 'dragging'
  }

  function dragFrame(now: number) {
    if (phase.value !== 'dragging') { dragRaf = 0; return }
    const elapsed = Math.min(1 / 30, Math.max(1 / 240, (now - dragLastAt) / 1000))
    dragLastAt = now
    const delta = dragTarget - visualPosition.value
    velocity += (DRAG_SPRING * delta - DRAG_DAMPING * velocity) * elapsed
    setPosition(visualPosition.value + velocity * elapsed)
    if (Math.abs(delta) > 0.001 || Math.abs(velocity) > 0.01) {
      dragRaf = requestAnimationFrame(dragFrame)
    } else {
      dragRaf = 0
      velocity = 0
      setPosition(dragTarget)
    }
  }

  function move(pointerX: number, ratio: number) {
    if (phase.value !== 'dragging') return
    const delta = pointerX - pointerStartX
    if (Math.abs(delta) > 3) moved = true
    const target = detentPosition(positionAtStart - (delta * ratio) / pitchAtStart, options.getCount())
    dragTarget = target
    if (!dragRaf) {
      dragLastAt = performance.now()
      dragRaf = requestAnimationFrame(dragFrame)
    }
  }

  function end(clickedIndex: number | null) {
    if (phase.value !== 'dragging') return
    const count = options.getCount()
    if (!count) return stopMotion()
    const last = count - 1
    const target = !moved && clickedIndex !== null
      ? clampScrubberPosition(clickedIndex, count)
      : Math.round(clampScrubberPosition(visualPosition.value + Math.max(-4, Math.min(4, velocity * 150)), count))
    settleTo(Math.min(last, target), velocity)
  }

  function settleTo(target: number, initialVelocity = 0) {
    const run = ++animationRun
    let position = visualPosition.value
    let springVelocity = initialVelocity
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
  return { visualPosition, dragging, animating, begin, move, end, stopMotion, syncExternal, settleTo }
}
