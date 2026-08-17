import { describe, it, expect, vi } from 'vitest'
import { optimisticMutation } from '@/utils/optimisticMutation'
import { beginOptimisticIntent, withOptimisticIntent } from '@/utils/optimisticIntent'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('optimisticMutation — 时序契约', () => {
  it('成功：apply → afterMutate → work → onCommit，不回滚', async () => {
    const order: string[] = []
    await optimisticMutation({
      apply: () => order.push('apply'),
      afterMutate: () => order.push('afterMutate'),
      work: async () => { order.push('work') },
      onCommit: () => order.push('onCommit'),
      rollback: () => order.push('rollback'),
      onError: () => order.push('onError'),
    })
    expect(order).toEqual(['apply', 'afterMutate', 'work', 'onCommit'])
  })

  it('失败：apply → afterMutate → work(抛) → rollback → afterMutate → onError', async () => {
    const order: string[] = []
    const err = new Error('boom')
    let caught: unknown = null
    await optimisticMutation({
      apply: () => order.push('apply'),
      afterMutate: () => order.push('afterMutate'),
      work: async () => { order.push('work'); throw err },
      onCommit: () => order.push('onCommit'),
      rollback: () => order.push('rollback'),
      onError: (e) => { order.push('onError'); caught = e },
    })
    expect(order).toEqual(['apply', 'afterMutate', 'work', 'rollback', 'afterMutate', 'onError'])
    expect(caught).toBe(err)
  })

  it('onCommit 可选：不传也不报错', async () => {
    const rollback = vi.fn()
    await optimisticMutation({
      apply: () => {}, afterMutate: () => {}, work: async () => {}, rollback, onError: () => {},
    })
    expect(rollback).not.toHaveBeenCalled()
  })

  it('成功时 rollback 绝不被调用；失败时 onCommit 绝不被调用', async () => {
    const okRollback = vi.fn(); const okCommit = vi.fn()
    await optimisticMutation({ apply(){}, afterMutate(){}, work: async()=>{}, rollback: okRollback, onCommit: okCommit, onError(){} })
    expect(okRollback).not.toHaveBeenCalled(); expect(okCommit).toHaveBeenCalledOnce()

    const failRollback = vi.fn(); const failCommit = vi.fn()
    await optimisticMutation({ apply(){}, afterMutate(){}, work: async()=>{ throw new Error('x') }, rollback: failRollback, onCommit: failCommit, onError(){} })
    expect(failRollback).toHaveBeenCalledOnce(); expect(failCommit).not.toHaveBeenCalled()
  })

  it('regrab 立即 apply 新状态，但同一对象的 persistence 必须等待旧请求结算后再启动', async () => {
    const first = deferred()
    const second = deferred()
    let state = 'A'
    let secondStarted = false
    const key = 'test-order:file:1'

    const firstWork = withOptimisticIntent(beginOptimisticIntent([key]), () => optimisticMutation({
      apply: () => { state = 'B' }, afterMutate: () => {}, work: () => first.promise,
      rollback: () => { state = 'A' }, onError: () => {},
    }))
    const secondWork = withOptimisticIntent(beginOptimisticIntent([key]), () => optimisticMutation({
      apply: () => { state = 'C' },
      afterMutate: () => {},
      work: () => { secondStarted = true; return second.promise },
      rollback: () => { state = 'B' },
      onError: () => {},
    }))

    expect(state).toBe('C')
    expect(secondStarted).toBe(false)
    first.resolve()
    await firstWork
    await Promise.resolve()
    expect(secondStarted).toBe(true)
    second.resolve()
    await secondWork
    expect(state).toBe('C')
  })

  it('regrab 新意图已 apply 时，旧请求失败不覆盖新状态；新请求成功后丢弃旧 rollback', async () => {
    const first = deferred()
    const second = deferred()
    let state = 'A'
    const firstRollback = vi.fn(() => { state = 'A' })
    const secondRollback = vi.fn(() => { state = 'B' })
    const key = 'test-success:file:1'

    const firstIntent = beginOptimisticIntent([key])
    const firstWork = withOptimisticIntent(firstIntent, () => optimisticMutation({
      apply: () => { state = 'B' },
      afterMutate: () => {},
      work: () => first.promise,
      rollback: firstRollback,
      onError: () => {},
    }))
    const secondIntent = beginOptimisticIntent([key])
    const secondWork = withOptimisticIntent(secondIntent, () => optimisticMutation({
      apply: () => { state = 'C' },
      afterMutate: () => {},
      work: () => second.promise,
      rollback: secondRollback,
      onError: () => {},
    }))

    expect(state).toBe('C')
    first.reject(new Error('first failed'))
    await firstWork
    expect(state).toBe('C')
    expect(firstRollback).not.toHaveBeenCalled()

    second.resolve()
    await secondWork
    expect(state).toBe('C')
    expect(secondRollback).not.toHaveBeenCalled()
  })

  it('连续 regrab 的所有请求都失败时，rollback chain 回到最后确认状态而非中间乐观态', async () => {
    const first = deferred()
    const second = deferred()
    let state = 'A'
    const firstRollback = vi.fn(() => { state = 'A' })
    const secondRollback = vi.fn(() => { state = 'B' })
    const key = 'test-failure:file:1'

    const firstWork = withOptimisticIntent(beginOptimisticIntent([key]), () => optimisticMutation({
      apply: () => { state = 'B' }, afterMutate: () => {}, work: () => first.promise,
      rollback: firstRollback, onError: () => {},
    }))
    const secondWork = withOptimisticIntent(beginOptimisticIntent([key]), () => optimisticMutation({
      apply: () => { state = 'C' }, afterMutate: () => {}, work: () => second.promise,
      rollback: secondRollback, onError: () => {},
    }))

    first.reject(new Error('first failed'))
    await firstWork
    expect(state).toBe('C')

    second.reject(new Error('second failed'))
    await secondWork
    expect(secondRollback).toHaveBeenCalledOnce()
    expect(firstRollback).toHaveBeenCalledOnce()
    expect(state).toBe('A')
  })
})
