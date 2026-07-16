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

  it('协调器接管时移除 Vue move，并在取消后清理 ownership', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    element.classList.add('drawer-project-cards-move')
    const tx = createFlipTransaction({ easing: 'linear' })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    const play = tx.play()
    expect(element.classList.contains('drawer-project-cards-move')).toBe(false)
    expect(element.dataset.flipOwner).toBe('coordinator')
    tx.cancel()
    expect(await play).toBe('cancelled')
    expect(element.dataset.flipOwner).toBeUndefined()
  })

  it('恢复事务接管前的外部 ownership 标记', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    element.dataset.flipOwner = 'external'
    const tx = createFlipTransaction({ easing: 'linear' })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    const play = tx.play()
    expect(element.dataset.flipOwner).toBe('coordinator')
    tx.cancel()
    expect(await play).toBe('cancelled')
    expect(element.dataset.flipOwner).toBe('external')
  })

  it('阶段顺序不完整时不会写入动画样式', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const tx = createFlipTransaction({ easing: 'linear' })

    expect(await tx.play()).toBe('skipped')
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    tx.measure([{ key: 'card', element }], [rect(40, 0)])
    const play = tx.play()
    expect(element.style.transform).toBe('translate(-20.00px, 0.00px)')
    tx.capture([{ key: 'card', element }], [rect(80, 0)])
    tx.cancel()
    expect(await play).toBe('cancelled')
  })

  it('transitionend 只接受本元素的 transform 事件并完成事务', async () => {
    const element = document.createElement('div')
    const child = document.createElement('span')
    element.appendChild(child)
    document.body.appendChild(element)
    const tx = createFlipTransaction({ easing: 'linear', duration: 1000 })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    const play = tx.play()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))

    child.dispatchEvent(new TransitionEvent('transitionend', { propertyName: 'transform', bubbles: true }))
    expect(element.style.transform).toBe('')
    element.dispatchEvent(new TransitionEvent('transitionend', { propertyName: 'opacity' }))
    expect(element.style.transition).toContain('1000ms')
    element.dispatchEvent(new TransitionEvent('transitionend', { propertyName: 'transform' }))
    expect(await play).toBe('finished')
  })

  it('播放期间元素卸载时由 fallback 结束事务且不残留样式', async () => {
    vi.useFakeTimers()
    const element = document.createElement('div')
    document.body.appendChild(element)
    const tx = createFlipTransaction({ easing: 'linear', duration: 10 })
    tx.capture([{ key: 'card', element }], [rect(0, 0)])
    tx.measure([{ key: 'card', element }], [rect(20, 0)])
    const play = tx.play()
    element.remove()
    await vi.runAllTimersAsync()
    expect(await play).toBe('finished')
    expect(element.style.transform).toBe('')
    expect(element.dataset.flipOwner).toBeUndefined()
    vi.useRealTimers()
  })
})
