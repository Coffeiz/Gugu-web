import { effectScope } from 'vue'
import { expect, it, vi } from 'vitest'
import type { RuntimeEvent } from '@/interaction/runtime'
import { useDesktopFileDrag } from '@/composables/files/useDesktopFileDrag'

const nativeDrag = vi.hoisted(() => ({
  subscribe: vi.fn<(handler: (event: RuntimeEvent) => void) => () => void>(),
  cancel: vi.fn(),
  getVisualProxy: vi.fn(),
  toPng: vi.fn(),
}))
vi.mock('@/interaction/runtime', () => ({ runtime: nativeDrag }))
vi.mock('html-to-image', () => ({ toPng: nativeDrag.toPng }))

it('左键拖动在窗内继续跟手，越界后只交接一次且不提交内部落点', async () => {
  let callback: ((event: RuntimeEvent) => void) | undefined
  nativeDrag.subscribe.mockImplementation(listener => {
    callback = listener
    return () => { callback = undefined }
  })
  const scope = effectScope()
  const track = scope.run(useDesktopFileDrag)!
  const start = vi.fn()
  const card = document.createElement('div')
  const grabbed = document.createElement('div')
  grabbed.className = 'fc-card'
  nativeDrag.getVisualProxy.mockReturnValue({ element: grabbed })
  const image = Promise.withResolvers<string>()
  nativeDrag.toPng.mockReturnValue(image.promise)
  let captured = false
  card.hasPointerCapture = () => captured
  card.setPointerCapture = () => { captured = true }
  card.releasePointerCapture = () => { captured = false }
  const pointer = { pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1, isPrimary: true }
  const move = (clientX: number, buttons = 1) => {
    window.dispatchEvent(new PointerEvent('pointermove', { ...pointer, clientX, clientY: 10, buttons }))
  }
  card.addEventListener('pointerdown', event => track(event, 'file:synthetic', start))
  try {
    card.dispatchEvent(new PointerEvent('pointerdown', pointer))
    move(-1)
    expect(start).not.toHaveBeenCalled()
    callback?.({
      type: 'move-visual-update', objectId: 'file:synthetic', sessionId: 'synthetic-session', phase: 'active',
      rect: { x: 10, y: 10, width: 100, height: 100 },
    })
    move(20)
    expect(captured).toBe(true)
    expect(start).not.toHaveBeenCalled()
    move(-1)
    move(-2)
    expect(start).not.toHaveBeenCalled()
    expect(nativeDrag.toPng).toHaveBeenCalledExactlyOnceWith(grabbed, expect.objectContaining({ includeQueryParams: true }))
    image.resolve('data:image/png;base64,synthetic')
    await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith('data:image/png;base64,synthetic'))
    expect(captured).toBe(false)
    expect(nativeDrag.cancel).toHaveBeenCalledExactlyOnceWith('synthetic-session', 'native-file-drag')
    expect(start).toHaveBeenCalledOnce()
    expect(nativeDrag.cancel.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!)

    card.dispatchEvent(new PointerEvent('pointerdown', pointer))
    window.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }))
    expect(callback).toBeUndefined()
    move(-1)
    expect(start).toHaveBeenCalledOnce()
  } finally { scope.stop() }
})

it('窗内拖拽松手不打开文件，下一次单击和键盘激活仍能打开', () => {
  let callback: ((event: RuntimeEvent) => void) | undefined
  nativeDrag.subscribe.mockImplementation(listener => {
    callback = listener
    return () => { callback = undefined }
  })
  nativeDrag.toPng.mockResolvedValue('data:image/png;base64,synthetic')
  const scope = effectScope()
  const track = scope.run(useDesktopFileDrag)!
  const card = document.createElement('div')
  const name = card.appendChild(document.createElement('button'))
  document.body.append(card)
  card.hasPointerCapture = () => false
  card.setPointerCapture = () => {}
  const open = vi.fn()
  const start = vi.fn()
  name.addEventListener('click', open)
  card.addEventListener('pointerdown', event => track(event, 'file:synthetic', start))
  const pointer = { bubbles: true, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1, isPrimary: true }
  const release = () => name.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }))
  const click = (detail: number) => name.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }))
  const drag = () => {
    name.dispatchEvent(new PointerEvent('pointerdown', pointer))
    callback?.({
      type: 'move-visual-update', objectId: 'file:synthetic', sessionId: 'synthetic-session', phase: 'active',
      rect: { x: 10, y: 10, width: 100, height: 100 },
    })
    release()
  }
  try {
    drag()
    expect(click(1)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()

    drag()
    click(0)
    expect(open).toHaveBeenCalledOnce()
    name.dispatchEvent(new PointerEvent('pointerdown', pointer))
    release()
    click(1)
    expect(open).toHaveBeenCalledTimes(2)
  } finally {
    scope.stop()
    card.remove()
  }
})
