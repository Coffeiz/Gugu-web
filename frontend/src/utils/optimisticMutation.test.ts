import { describe, it, expect, vi } from 'vitest'
import { optimisticMutation } from './optimisticMutation'

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
    expect(caught).toBe(err)          // 原始错误对象透传给 onError
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
})
