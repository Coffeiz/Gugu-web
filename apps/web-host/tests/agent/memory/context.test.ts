import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createAgentMemoryContextLoader } from '../../../src/modules/agent/memory/context.js'

test('Host memory context loader reads only the authenticated owner memory root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-memory-context-'))
  const owner = randomUUID(), other = randomUUID()
  try {
    await mkdir(join(root, owner, '.agent', 'memories'), { recursive: true })
    await mkdir(join(root, other, '.agent', 'memories'), { recursive: true })
    await writeFile(join(root, owner, '.agent', 'memories', 'profile.json'), JSON.stringify([{ text: 'owner fact' }]))
    await writeFile(join(root, other, '.agent', 'memories', 'profile.json'), JSON.stringify([{ text: 'other fact' }]))
    const load = createAgentMemoryContextLoader(root, () => 125_000)
    const result = await load({ ownerId: owner, sessionId: '1' }, new AbortController().signal)
    assert.ok(result && typeof result === 'object' && !Array.isArray(result))
    assert.equal(result.profile, '- owner fact')
    assert.doesNotMatch(JSON.stringify(result), /other fact/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Host vector lookup receives the authenticated owner and current turn query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-memory-vectors-'))
  const owner = randomUUID(), patterns = Array.from({ length: 51 }, (_, index) => ({
    id: `p${index}`, text: `pattern ${index}`, kind: 'observed', conf: 0.9, imp: 3, ts: 100,
  }))
  const calls: unknown[] = []
  try {
    await mkdir(join(root, owner, '.agent', 'memories'), { recursive: true })
    await writeFile(join(root, owner, '.agent', 'memories', 'pattern.json'), JSON.stringify(patterns))
    const load = createAgentMemoryContextLoader(root, () => 125_000, vectorOwner => ({
      async embed(inputOwner, query) { calls.push(['embed', vectorOwner, inputOwner, query]); return { vector: [1], modelTag: 'synthetic-model' } },
      async read(inputOwner, kind) { calls.push(['read', vectorOwner, inputOwner, kind]); return {} },
    }))
    await load({ ownerId: owner, sessionId: '1' }, new AbortController().signal, '本轮查询')
    assert.deepEqual(calls, [
      ['embed', owner, owner, '本轮查询'],
      ['read', owner, owner, 'pattern'],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
