// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, ref } from 'vue'
import { useWindowDrag } from '@/composables/core/useWindowDrag'

const mounted: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = []
afterEach(() => { for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() } })

function mountDrag(constrain?: (x: number, y: number) => { x: number; y: number }) {
  const x = ref(40)
  const y = ref(60)
  let drag!: ReturnType<typeof useWindowDrag>
  const app = createApp({ setup() { drag = useWindowDrag(x, y, constrain); return () => h('div') } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  mounted.push({ app, host })
  return { x, y, drag, app }
}
function pointer(type: string, x: number, y: number, button = 0) {
  return new MouseEvent(type, { clientX: x, clientY: y, button })
}

describe('浮窗拖动的共用鼠标生命周期', () => {
  it('仅主键开始拖动，松开后后续移动不再改变位置', () => {
    const { x, y, drag } = mountDrag()
    drag.startDrag(pointer('mousedown', 10, 20, 2))
    window.dispatchEvent(pointer('mousemove', 30, 50))
    expect([x.value, y.value]).toEqual([40, 60])
    drag.startDrag(pointer('mousedown', 10, 20))
    window.dispatchEvent(pointer('mousemove', 30, 50))
    expect([x.value, y.value]).toEqual([60, 90])
    window.dispatchEvent(pointer('mouseup', 30, 50))
    window.dispatchEvent(pointer('mousemove', 90, 90))
    expect([x.value, y.value]).toEqual([60, 90])
  })

  it('信息弹层保留调用方的非负边界，独立偏移模式允许负值', () => {
    const bounded = mountDrag((x, y) => ({ x: Math.max(0, x), y: Math.max(0, y) }))
    const offset = mountDrag()
    bounded.drag.startDrag(pointer('mousedown', 100, 100))
    offset.drag.startDrag(pointer('mousedown', 100, 100))
    window.dispatchEvent(pointer('mousemove', 0, 0))
    expect([bounded.x.value, bounded.y.value]).toEqual([0, 0])
    expect([offset.x.value, offset.y.value]).toEqual([-60, -40])
  })

  it('拖动期间实时读取窗口边界，保留主预览窗的动态尺寸约束', () => {
    let maxX = 100
    const { x, y, drag } = mountDrag((x, y) => ({ x: Math.min(maxX, x), y }))
    drag.startDrag(pointer('mousedown', 0, 0))
    window.dispatchEvent(pointer('mousemove', 200, 20))
    expect([x.value, y.value]).toEqual([100, 80])
    maxX = 70
    window.dispatchEvent(pointer('mousemove', 200, 20))
    expect(x.value).toBe(70)
  })

  it('卸载正在拖动的窗口会移除监听，不影响其他窗口的拖动', () => {
    const first = mountDrag()
    const second = mountDrag()
    first.drag.startDrag(pointer('mousedown', 0, 0))
    second.drag.startDrag(pointer('mousedown', 0, 0))
    first.app.unmount()
    mounted.splice(0, 1)[0].host.remove()
    window.dispatchEvent(pointer('mousemove', 10, 20))
    expect([first.x.value, first.y.value]).toEqual([40, 60])
    expect([second.x.value, second.y.value]).toEqual([50, 80])
  })
})
