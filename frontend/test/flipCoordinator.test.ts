import { describe, expect, it, vi } from 'vitest'
import { createFlipTransaction } from '../src/interaction/drag/animation/flipCoordinator'

const rect = (left: number, top: number): DOMRect => ({
  left, top, width: 40, height: 20, right: left + 40, bottom: top + 20,
  x: left, y: top, toJSON: () => ({}),
} as DOMRect)

describe('FLIP 协调器', () => {
  it('按稳定 key 对齐前后位置，不依赖数组顺序', async () => {
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(first, second)
    const tx = createFlipTransaction({ easing: 'linear' })
    tx.capture([{ key: 'first', element: first }, { key: 'second', element: second }], [rect(0, 0), rect(0, 30)])
    tx.measure([{ key: 'second', element: second }, { key: 'first', element: first }], [rect(0, 0), rect(0, 30)])
    const play = tx.play()
    expect(first.style.transform).toBe('translate(0.00px, -30.00px)')
    expect(second.style.transform).toBe('translate(0.00px, 30.00px)')
    tx.cancel()
    expect(await play).toBe('cancelled')
  })

  it('cancel 只恢复本事务仍拥有的 inline 样式', async () => {
    vi.useFakeTimers()
    const element = document.createElement('div')
    document.body.appendChild(element)
    element.style.transform = 'scale(1)'
    const tx = createFlipTransaction({ easing: 'linear', duration: 10 })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    const play = tx.play()
    tx.cancel()
    expect(element.style.transform).toBe('scale(1)')
    expect(await play).toBe('cancelled')
    vi.useRealTimers()
  })

  it('旧事务不会覆盖新事务接管的 transform', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const first = createFlipTransaction({ easing: 'linear' })
    first.capture([{ key: 'card', element }], [rect(0, 0)])
    first.measure([{ key: 'card', element }], [rect(20, 0)])
    const firstPlay = first.play()

    const second = createFlipTransaction({ easing: 'linear' })
    second.capture([{ key: 'card', element }], [rect(20, 0)])
    second.measure([{ key: 'card', element }], [rect(0, 0)])
    const secondPlay = second.play()
    first.cancel()

    expect(element.style.transform).not.toBe('')
    second.cancel()
    expect(await firstPlay).toBe('cancelled')
    expect(await secondPlay).toBe('cancelled')
  })

  it('正常完成后恢复事务开始前的 inline 样式', async () => {
    vi.useFakeTimers()
    const element = document.createElement('div')
    document.body.appendChild(element)
    element.style.transform = 'scale(1)'
    const tx = createFlipTransaction({ easing: 'linear', duration: 10 })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    const play = tx.play()
    await vi.runAllTimersAsync()
    expect(await play).toBe('finished')
    expect(element.style.transform).toBe('scale(1)')
    vi.useRealTimers()
  })

  it('session 门禁失效时不会写入 inverse transform', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const tx = createFlipTransaction({ easing: 'linear', isActive: () => false })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    expect(await tx.play()).toBe('stale')
    expect(element.style.transform).toBe('')
  })

  it('跳过 Vue 临时挂载产生的 0×0 元素', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const tx = createFlipTransaction({ easing: 'linear' })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [{ ...rect(20, 0), width: 0, height: 0 } as DOMRect])
    expect(await tx.play()).toBe('skipped')
  })
})
