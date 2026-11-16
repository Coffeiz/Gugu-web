import { createUserMemoryVectorRebuilder } from '../../src/byok/vector-rebuild.js'
import { expect, it, vi } from 'vitest'

const owner = '8ef418ec-8bad-44d2-9c16-317fae7a849d'

it('按 Python chunk 规则重建用户 pattern 与 memory 向量，并清除已删除来源的孤儿向量', async () => {
  const writes: Array<{ kind: string; value: Record<string, { v: number[]; t: string }> }> = []
  const embed = vi.fn(async (_ownerId: string, text: string) => [text.length, 0.5])
  const rebuildMemoryIndex = vi.fn(async () => undefined)
  const rebuild = createUserMemoryVectorRebuilder({
    readPatterns: async () => [
      { id: 'p1', text: '  用户喜欢慢慢规划。  ' },
      { id: '', text: '忽略无 ID 记录' },
      { id: 'p2', text: '  ' },
    ],
    readMemory: async () => '## 记录长期记忆：项目\n\n最近在整理项目。',
    readVectors: async kind => kind === 'pattern'
      ? { p1: { v: [1], t: 'old' }, removed: { v: [9], t: 'old' } }
      : { stale: { v: [9], t: 'old' } },
    writeVectors: async (ownerId, kind, value) => {
      expect(ownerId).toBe(owner)
      writes.push({ kind, value })
    },
    embed,
    rebuildMemoryIndex,
  })

  const result = await rebuild(owner, 'dashscope:text-embedding-v4:default')

  expect(result).toEqual({ patternVectors: 1, memoryVectors: 1, withPatterns: 1, failedUsers: 0, ragIndexFailed: false })
  expect(rebuildMemoryIndex).toHaveBeenCalledWith(owner, expect.any(AbortSignal))
  expect(embed.mock.calls.map(([, text]) => text)).toEqual(['用户喜欢慢慢规划。', '## 记录长期记忆：项目\n\n最近在整理项目。'])
  expect(writes).toEqual([
    { kind: 'pattern', value: { p1: { v: [9, 0.5], t: 'dashscope:text-embedding-v4:default' } } },
    { kind: 'memory', value: { '622c2dbc8aaa': { v: [22, 0.5], t: 'dashscope:text-embedding-v4:default' } } },
  ])
})

it('嵌入失败时不写入半成品向量，并继续触发 RAG 索引重建', async () => {
  const writeVectors = vi.fn()
  const rebuildMemoryIndex = vi.fn(async () => undefined)
  const rebuild = createUserMemoryVectorRebuilder({
    readPatterns: async () => [{ id: 'p1', text: '保留旧值' }],
    readMemory: async () => '',
    readVectors: async () => ({ p1: { v: [1], t: 'old' } }),
    writeVectors,
    embed: async () => { throw new Error('embedding unavailable') },
    rebuildMemoryIndex,
  })

  await expect(rebuild(owner, 'new:model:default')).resolves.toEqual({
    patternVectors: 0, memoryVectors: 0, withPatterns: 0, failedUsers: 1, ragIndexFailed: false,
  })
  expect(writeVectors).not.toHaveBeenCalled()
  expect(rebuildMemoryIndex).toHaveBeenCalledWith(owner, expect.any(AbortSignal))
})

it('来源被清空时删除遗留向量，防止已删除记忆继续参与语义召回', async () => {
  const writes: Array<{ kind: string; value: unknown }> = []
  const rebuild = createUserMemoryVectorRebuilder({
    readPatterns: async () => [],
    readMemory: async () => '',
    readVectors: async (_ownerId, kind) => kind === 'pattern' ? { deleted: { v: [1], t: 'old' } } : { deleted: { v: [2], t: 'old' } },
    writeVectors: async (_ownerId, kind, value) => { writes.push({ kind, value }) },
    embed: async () => { throw new Error('空来源不应触发 embedding') },
    rebuildMemoryIndex: async () => undefined,
  })

  await expect(rebuild(owner, 'new:model:default')).resolves.toEqual({
    patternVectors: 0, memoryVectors: 0, withPatterns: 0, failedUsers: 0, ragIndexFailed: false,
  })
  expect(writes).toEqual([{ kind: 'pattern', value: {} }, { kind: 'memory', value: {} }])
})

it('RAG 索引失败时保留已写向量计数并显式报告失败', async () => {
  const rebuild = createUserMemoryVectorRebuilder({
    readPatterns: async () => [{ id: 'p1', text: '保留的偏好' }],
    readMemory: async () => '',
    readVectors: async () => ({}),
    writeVectors: async () => undefined,
    embed: async () => [1, 2],
    rebuildMemoryIndex: async () => { throw new Error('synthetic RAG failure') },
  })

  await expect(rebuild(owner, 'new:model:default')).resolves.toEqual({
    patternVectors: 1, memoryVectors: 0, withPatterns: 1, failedUsers: 0, ragIndexFailed: true,
  })
})
