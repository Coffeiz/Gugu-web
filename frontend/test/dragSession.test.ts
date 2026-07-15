import { describe, expect, it, vi } from 'vitest'
import { DragRegistry } from '../src/interaction/drag/core/DragRegistry'
import { DragSession } from '../src/interaction/drag/core/DragSession'

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
