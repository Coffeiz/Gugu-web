// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { effectScope } from 'vue'
import { useFileDropHover } from '@/composables/files/useFileDropHover'

it('嵌套 enter 不累积，离开外边界及取消拖动清理覆盖层', () => {
  const scope = effectScope()
  const hover = scope.run(() => useFileDropHover())!
  const root = document.createElement('div')
  root.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 100 }) as DOMRect
  const event = { currentTarget: root, dataTransfer: { types: ['Files'] }, preventDefault() {} } as unknown as DragEvent
  hover.enter(event); hover.enter(event)
  expect(hover.active.value).toBe(true)
  hover.leave({ relatedTarget: null, clientX: 110, clientY: 30 } as DragEvent)
  expect(hover.active.value).toBe(false)
  hover.enter(event)
  window.dispatchEvent(new Event('dragend'))
  expect(hover.active.value).toBe(false)
  hover.enter(event)
  window.dispatchEvent(new Event('blur'))
  expect(hover.active.value).toBe(false)
  scope.stop()
})

it('容器内部移动保持覆盖，普通文本不激活上传提示', () => {
  const scope = effectScope()
  const hover = scope.run(() => useFileDropHover())!
  const root = document.createElement('div'), child = document.createElement('span')
  root.append(child)
  hover.enter({ currentTarget: root, dataTransfer: { types: ['text/plain'] }, preventDefault() {} } as unknown as DragEvent)
  expect(hover.active.value).toBe(false)
  hover.enter({ currentTarget: root, dataTransfer: { types: ['Files'] }, preventDefault() {} } as unknown as DragEvent)
  hover.leave({ relatedTarget: child } as unknown as DragEvent)
  expect(hover.active.value).toBe(true)
  scope.stop()
  expect(hover.active.value).toBe(false)
})
