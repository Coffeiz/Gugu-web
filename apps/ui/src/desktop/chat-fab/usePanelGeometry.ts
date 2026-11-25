import { onMounted, onUnmounted } from 'vue'
import { chatFabHost, type PanelBounds, type PanelGeometry } from './bridge'

const gutter = 4

export function usePanelGeometry() {
  const style = document.documentElement.style
  let frame = 0
  let active: PanelGeometry | undefined
  let drawn: PanelBounds | undefined
  let unsubscribe: (() => void) | undefined

  function place(bounds: PanelBounds, origin: { x: number; y: number }) {
    drawn = bounds
    style.setProperty('--native-chat-left', `${bounds.x - origin.x + gutter}px`)
    style.setProperty('--native-chat-top', `${bounds.y - origin.y + gutter}px`)
    style.setProperty('--native-chat-width', `${Math.max(0, bounds.width - gutter * 2)}px`)
    style.setProperty('--native-chat-height', `${Math.max(0, bounds.height - gutter * 2)}px`)
  }

  function clearGeometry() {
    for (const edge of ['left', 'top', 'width', 'height']) style.removeProperty(`--native-chat-${edge}`)
    drawn = undefined
  }

  function receive(geometry: PanelGeometry) {
    cancelAnimationFrame(frame)
    const interrupted = active && 'duration' in active
    active = geometry
    if (!('duration' in geometry)) {
      const { target, frame: viewport } = geometry
      // Electron 改原生视口和 Chromium 更新屏幕坐标可能相差一帧。
      const deadline = performance.now() + 250
      const settle = (now: number) => {
        if (active !== geometry) return
        const origin = { x: window.screenX, y: window.screenY }
        const pending = Math.abs(origin.x - viewport.x) > 1 || Math.abs(origin.y - viewport.y) > 1
          || Math.abs(window.innerWidth - viewport.width) > 1 || Math.abs(window.innerHeight - viewport.height) > 1
        if (geometry.reframe && pending && now < deadline) {
          place(target, origin)
          frame = requestAnimationFrame(settle)
        } else if (target.x === viewport.x && target.y === viewport.y &&
          target.width === viewport.width && target.height === viewport.height) clearGeometry()
        else place(target, viewport)
      }
      settle(performance.now())
      return
    }

    const from = interrupted && drawn ? drawn : geometry.from
    const { target, duration } = geometry
    let started: number | undefined
    const received = performance.now()
    function tick(now: number) {
      if (active !== geometry) return
      const viewport = geometry.frame
      if (started === undefined && now - received < 250 &&
        (Math.abs(window.innerWidth - viewport.width) > 1 || Math.abs(window.innerHeight - viewport.height) > 1 ||
          Math.abs(window.screenX - viewport.x) > 1 || Math.abs(window.screenY - viewport.y) > 1)) {
        place(from, { x: window.screenX, y: window.screenY })
        frame = requestAnimationFrame(tick)
        return
      }
      started ??= now
      const elapsed = Math.min(1, (now - started) / duration)
      const eased = 1 - (1 - elapsed) ** 3
      const mix = (a: number, b: number) => a + (b - a) * eased
      const right = mix(from.x + from.width, target.x + target.width)
      const bottom = mix(from.y + from.height, target.y + target.height)
      const width = mix(from.width, target.width)
      const height = mix(from.height, target.height)
      place({ x: right - width, y: bottom - height, width, height }, { x: window.screenX, y: window.screenY })
      if (elapsed < 1) frame = requestAnimationFrame(tick)
      else chatFabHost?.panelGeometryDone(geometry.id)
    }
    place(from, { x: window.screenX, y: window.screenY })
    frame = requestAnimationFrame(tick)
  }

  onMounted(() => { unsubscribe = chatFabHost?.onPanelGeometry(receive) })
  onUnmounted(() => {
    unsubscribe?.()
    active = undefined
    cancelAnimationFrame(frame)
    clearGeometry()
  })
}
