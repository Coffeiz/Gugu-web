import { onUnmounted, type Ref } from 'vue'

type Position = { x: number; y: number }

/** 浮窗与信息弹层共用鼠标拖动；各窗口自行提供已有的边界规则。 */
export function useWindowDrag(x: Ref<number>, y: Ref<number>, constrain?: (x: number, y: number) => Position) {
  let origin: { mouseX: number; mouseY: number; x: number; y: number } | null = null

  function move(event: MouseEvent) {
    if (!origin) return
    const nextX = origin.x + event.clientX - origin.mouseX
    const nextY = origin.y + event.clientY - origin.mouseY
    const position = constrain?.(nextX, nextY) ?? { x: nextX, y: nextY }
    x.value = position.x
    y.value = position.y
  }
  function stopDrag() {
    origin = null
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', stopDrag)
  }
  function startDrag(event: MouseEvent) {
    if (event.button !== 0) return
    origin = { mouseX: event.clientX, mouseY: event.clientY, x: x.value, y: y.value }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stopDrag)
  }

  onUnmounted(stopDrag)
  return { startDrag }
}
