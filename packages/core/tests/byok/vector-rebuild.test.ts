import { createHash } from 'node:crypto'
import { createUserLongMemoryVectorRefresher, createUserMemoryVectorRebuilder, createUserPatternVectorRefresher } from '../../src/byok/vector-rebuild.js'
import { expect, it, vi } from 'vitest'

const owner = '8ef418ec-8bad-44d2-9c16-317fae7a849d'
const memoryKey = (text: string) => createHash('md5').update(text).digest('hex').slice(0, 12)

it('长期记忆只补算新增或换模型的分段，保留当前模型的缓存', async () => {
  const original = { v: [0.1], t: 'same-model' }
  const writeVectors = vi.fn()
  const embed = vi.fn(async () => [0.2])
  const refresh = createUserLongMemoryVectorRefresher({
    readMemory: async () => '保留的长期记忆\n\n迁入的新事件\n\n旧模型计算的分段',
    readVectors: async () => ({
      [memoryKey('保留的长期记忆')]: original,
      [memoryKey('旧模型计算的分段')]: { v: [0.3], t: 'old-model' },
      obsolete: { v: [9], t: 'same-model' },
    }),
    writeVectors, embed, withSourceLock: (_owner, operation) => operation(),
  })
  const signal = new AbortController().signal
  await refresh(owner, 'same-model', signal)
  expect(embed.mock.calls).toEqual([[owner, '迁入的新事件', signal], [owner, '旧模型计算的分段', signal]])
  expect(writeVectors).toHaveBeenCalledExactlyOnceWith(owner, 'memory', {
    [memoryKey('保留的长期记忆')]: original, [memoryKey('迁入的新事件')]: { v: [0.2], t: 'same-model' },
    [memoryKey('旧模型计算的分段')]: { v: [0.2], t: 'same-model' },
  })
})

it.each(['正文', '缓存'])('长期记忆的%s在模型请求期间变更时，不发布旧结果', async changed => {
  let memory = '旧长期记忆'
  let vectors: unknown = {}
  const writeVectors = vi.fn()
  const refresh = createUserLongMemoryVectorRefresher({
    readMemory: async () => memory, readVectors: async () => vectors, writeVectors,
    withSourceLock: (_owner, operation) => operation(),
    async embed() {
      if (changed === '正文') memory = '另一次提交的长期记忆'
      else vectors = { [memoryKey(memory)]: { v: [2], t: 'newer-model' } }
      return [1]
    },
  })
  await refresh(owner, 'model-tag', new AbortController().signal)
  expect(writeVectors).not.toHaveBeenCalled()
})

it('全量重建不会覆盖生成期间已发布的新模型缓存', async () => {
  let vectors: Record<string, unknown> = {}
  const newer = { p1: { v: [2], t: 'new-model' } }
  const writeVectors = vi.fn()
  const rebuild = createUserMemoryVectorRebuilder({
    readPatterns: async () => [{ id: 'p1', text: '同一档案' }],
    readMemory: async () => '',
    readVectors: async () => vectors,
    writeVectors,
    async embed() {
      vectors = newer
      return [1]
    },
    rebuildMemoryIndex: async () => undefined,
  })
  expect((await rebuild(owner, 'old-model')).failedUsers).toBe(1)
  expect(writeVectors).not.toHaveBeenCalled()
  expect(vectors).toEqual(newer)
})

it('并发管理重建发布向量后，增量刷新保留新缓存', async () => {
  let vectors: Record<string, unknown> = {}
  const newer = { p1: { v: [2], t: '管理重建' } }
  const writeVectors = vi.fn()
  const refresh = createUserPatternVectorRefresher({
    readPatterns: async () => [{ id: 'p1', text: '同一偏好' }],
    readVectors: async () => vectors,
    writeVectors,
    withSourceLock: (_owner, operation) => operation(),
    async embed() {
      vectors = newer
      return [1]
    },
  })
  await refresh(owner, '增量刷新', new AbortController().signal)
  expect(writeVectors).not.toHaveBeenCalled()
  expect(vectors).toEqual(newer)
})

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
