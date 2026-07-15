import { describe, expect, it, vi } from 'vitest'
import { DragRegistry } from '../src/interaction/drag/core/DragRegistry'
import { DragSession } from '../src/interaction/drag/core/DragSession'
import { cloneForDrag, createLandingClone } from '../src/interaction/drag/visual/clone'
import { dispatchDragHandoff } from '../src/interaction/drag/interaction/handoff'
import { integrateSpring } from '../src/interaction/drag/core/physics'
import { morphTransform } from '../src/interaction/drag/animation/morph'

describe('DragSession', () => {
  it('只管理生命周期并按顺序执行清理', () => {
    const session = new DragSession('drag-test', 123)
    const first = vi.fn()
    const second = vi.fn()

    session.addCleanup(first)
    session.addCleanup(second)
    session.setPhase('dragging')
    session.finish()
    session.finish()

    expect(session.id).toBe('drag-test')
    expect(session.startedAt).toBe(123)
    expect(session.phase).toBe('finished')
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('终止后新增清理会立即执行', () => {
    const session = new DragSession('drag-test')
    const cleanup = vi.fn()

    session.cancel()
    session.addCleanup(cleanup)

    expect(cleanup).toHaveBeenCalledOnce()
    expect(session.phase).toBe('cancelled')
  })
})

describe('DragRegistry', () => {
  it('只取消同一源卡的旧 session', () => {
    const registry = new DragRegistry()
    const firstSource = document.createElement('div')
    const secondSource = document.createElement('div')
    const first = registry.start(firstSource)
    const second = registry.start(secondSource)

    expect(first.isCurrent()).toBe(true)
    expect(second.isCurrent()).toBe(true)

    const replacement = registry.start(firstSource)

    expect(first.phase).toBe('cancelled')
    expect(second.isCurrent()).toBe(true)
    expect(replacement.isCurrent()).toBe(true)
    expect(registry.current(firstSource)).toBe(replacement)
  })
})

describe('cloneForDrag', () => {
  it('复制内容并只修改拖拽视觉 class', () => {
    const source = document.createElement('div')
    source.className = 'source selected'
    source.innerHTML = '<span>内容</span>'

    const clone = cloneForDrag(source, {
      addClasses: ['phys-drag-clone'],
      removeClasses: ['selected'],
    })

    expect(clone).not.toBe(source)
    expect(clone.className).toBe('source phys-drag-clone')
    expect(clone.innerHTML).toBe('<span>内容</span>')
  })

  it('创建落地副本时清理源卡拖拽态并保留布局尺寸', () => {
    const source = document.createElement('div')
    source.className = 'phys-drag-source phys-drag-source-placeholder'
    source.innerHTML = '<div class="card-actions">操作</div>'

    const landing = createLandingClone(source, {
      width: 120,
      height: 80,
      layoutWidth: 100,
      layoutHeight: 60,
      zIndex: '2',
      transform: 'translate3d(0, 0, 0)',
      contentScale: 1,
    })
    const content = landing.querySelector('.phys-landing-content') as HTMLElement

    expect(content.classList.contains('phys-drag-source')).toBe(false)
    expect(content.classList.contains('phys-drag-source-placeholder')).toBe(false)
    expect(content.style.width).toBe('100px')
    landing.remove()
  })
})

describe('dispatchDragHandoff', () => {
  it('只通过统一事件协议通知目标是否接手', () => {
    const target = document.createElement('div')
    const event = new PointerEvent('pointermove')
    const initialRect = target.getBoundingClientRect()
    const listener = vi.fn((handoff: Event) => handoff.preventDefault())
    target.addEventListener('physics-landing-regrab', listener)

    expect(dispatchDragHandoff(target, event, initialRect)).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
  })
})

describe('integrateSpring', () => {
  it('使用固定子步积分位置和速度', () => {
    const state = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } }

    integrateSpring(state, { x: 100, y: 50 }, 360, 0.85, 1 / 60)

    expect(state.position.x).toBeGreaterThan(0)
    expect(state.position.y).toBeGreaterThan(0)
    expect(state.velocity.x).toBeGreaterThan(0)
  })
})

describe('morphTransform', () => {
  it('保持落点中心与尺寸缩放计算一致', () => {
    expect(morphTransform(
      { left: 10, top: 20, width: 200, height: 100 },
      { w: 100, h: 50 },
      { x: 50, y: 25 },
    )).toBe('translate3d(60.00px, 45.00px, 0) scale(2.0000, 2.0000)')
  })
})
