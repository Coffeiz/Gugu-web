import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createUserMemoryVectorRebuilder } from '@gugu/core/byok/vector-rebuild'
import { createLocalUserMemoryVectorStore } from '../../src/modules/byok/memory-vector-store.js'

test('Core 向量重建经 owner 绑定 Local 文件适配器持久化新向量并清除旧缓存', { skip: process.platform !== 'linux' && '生产安全写入适配器要求 Linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gugu-byok-vector-'))
  const owner = '00000000-0000-4000-8000-000000000102'
  const directory = path.join(root, owner, '.agent')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'pattern.json'), JSON.stringify([{ id: 'p1', text: '合成偏好' }]))
  await writeFile(path.join(directory, 'memory.md'), '长期合成记忆。')
  await writeFile(path.join(directory, 'pattern_vec.json'), JSON.stringify({ stale: { v: [9], t: 'old' } }))
  await writeFile(path.join(directory, 'memory_vec.json'), JSON.stringify({ stale: { v: [8], t: 'old' } }))
  const rebuildMemoryIndex = { calls: 0 }
  try {
    const rebuild = createUserMemoryVectorRebuilder({
      ...createLocalUserMemoryVectorStore(root),
      embed: async (_owner, text) => [text.length, 0.25],
      async rebuildMemoryIndex(ownerId) { assert.equal(ownerId, owner); rebuildMemoryIndex.calls += 1 },
    })
    await assert.doesNotReject(rebuild(owner, 'openai:synthetic-embedding:default'))
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'pattern_vec.json'), 'utf8')), {
      p1: { v: [4, 0.25], t: 'openai:synthetic-embedding:default' },
    })
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'memory_vec.json'), 'utf8')), {
      '1113c43e7042': { v: [7, 0.25], t: 'openai:synthetic-embedding:default' },
    })
    assert.equal(rebuildMemoryIndex.calls, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
