import { expect, it } from 'vitest'
import { createRememberTool } from '../../../src/agent/tools/memory.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'
import type { MemoryRow } from '../../../src/agent/memory/remember.js'

it('先按相似文本忘记，再记录新画像，按实际相似差异生成回执', async () => {
  const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
  let rows: MemoryRow[] = [{ type: 'address', text: '以前住在杭州附近', ts: 1 }]
  const tool = createRememberTool({
    async mutate(receipt, input, signal, edit) {
      expect(receipt).toEqual({ ...identity, roundId: 'round', toolCallId: 'record' })
      signal.throwIfAborted()
      expect(input.target).toBe('profile')
      const result = edit(rows)
      rows = result.rows
      return { kind: 'completed', successful: true, mutated: true, value: result.value }
    },
    async reconcile() { return { kind: 'unknown' } },
  }, () => 2)
  const registry = createToolRegistry({ authorize: async candidate => candidate.ownerId === identity.ownerId, tools: [tool] })
  const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('不执行进程') } }
  const dispatch = (input: unknown) => registry.tools.dispatch({ id: 'record', name: 'remember', input }, scope)
  expect(await dispatch({ text: ' 现在住在苏州 ', type: 'address', remove: ['以前住在杭州'] })).toMatchObject({ value: {
    success: true, added: 1, removed: 1, target: 'profile', remembered: '现在住在苏州',
  } })
  expect(rows).toEqual([{ type: 'address', text: '现在住在苏州', ts: 2 }])
  expect(await dispatch({ text: ' ' })).toMatchObject({ successful: false, mutated: false })
})

it('同义行为记录保留身份并更新置信度和重要度，删除时返回实际影响', async () => {
  const { applyRememberEdit } = await import('../../../src/agent/memory/remember.js')
  const before = [{ id: 'synthetic', text: '部署之前先运行扫描', kind: 'inferred', conf: 0.93, imp: 3, ts: 1 }]
  const updated = applyRememberEdit(before, {
    target: 'pattern', text: '部署之前先运行扫描', importance: 5, remove: [],
  }, 2, () => { throw new Error('相似条目须保留身份') })
  expect(updated.rows).toEqual([{ ...before[0], kind: 'observed', conf: 0.97, imp: 5, ts: 2 }])
  expect(updated.value).toMatchObject({ added: 0, removed: 0 })
  expect(applyRememberEdit(updated.rows, { target: 'pattern', text: '', remove: ['部署之前先运行扫描。'] }, 3, () => '')).toEqual({
    rows: [], value: { success: true, target: 'pattern', added: 0, removed: 1 },
  })
  expect(before[0]?.kind).toBe('inferred')
})
