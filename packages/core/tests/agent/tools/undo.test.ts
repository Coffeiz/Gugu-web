import { describe, expect, it } from 'vitest'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import { createUndoLastActionTool } from '../../../src/agent/tools/undo/index.js'
import type { UndoLastActionPort } from '../../../src/agent/tools/undo/index.js'

describe('undo_last_action tool', () => {
  it('通过真实 ToolRegistry 使用可信 Run 上下文并返回 Host 撤销结果', async () => {
    const calls: unknown[] = []
    const port: UndoLastActionPort = {
      async apply(input) {
        calls.push(input)
        return { kind: 'completed', successful: true, mutated: true, value: { operation_id: 'undo-target', idempotent: false } }
      },
      async reconcile() { return { kind: 'unknown' } },
    }
    const registry = createToolRegistry({
      groups: [{ id: 'undo', name: '撤销', tools: [createUndoLastActionTool(port)] }],
      authorize: async (_identity, name) => name === 'undo_last_action',
    })
    const identity = { ownerId: 'owner', sessionId: 'session', runId: 'run' }
    const result = await registry.tools.dispatch({ id: 'call-1', name: 'undo_last_action', input: {} }, {
      identity, roundId: 'round-2', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('撤销工具不得执行宿主命令') },
    })
    expect(result).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { operation_id: 'undo-target' } })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ identity, roundId: 'round-2', toolCallId: 'call-1' })
  })

  it('拒绝模型指定任何目标，并把相同调用坐标交给收据恢复', async () => {
    let applies = 0
    const reconciles: unknown[] = []
    const port: UndoLastActionPort = {
      async apply() { applies++; return { kind: 'unknown' } },
      async reconcile(input) { reconciles.push(input); return { kind: 'completed', successful: true, mutated: false, value: { idempotent: true } } },
    }
    const registry = createToolRegistry({
      groups: [{ id: 'undo', name: '撤销', tools: [createUndoLastActionTool(port)] }],
      authorize: async () => true,
    })
    const identity = { ownerId: 'owner', sessionId: 'session', runId: 'run' }
    const scope = { identity, roundId: 'round-3', signal: new AbortController().signal, execute: async () => { throw new Error('不应执行宿主命令') } }
    expect(await registry.tools.dispatch({ id: 'call-2', name: 'undo_last_action', input: { operation_id: 'other-users-action' } }, scope))
      .toMatchObject({ kind: 'completed', successful: false })
    expect(applies).toBe(0)
    expect(await registry.tools.reconcile({ id: 'call-2', name: 'undo_last_action', input: {} }, { ...identity, roundId: 'round-3' }))
      .toMatchObject({ kind: 'completed', successful: true, mutated: false })
    expect(reconciles).toEqual([{ identity: { ...identity, roundId: 'round-3' }, roundId: 'round-3', toolCallId: 'call-2' }])
  })
})
