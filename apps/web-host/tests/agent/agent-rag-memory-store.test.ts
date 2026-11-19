import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { UnsafeLocalPathError } from '@gugu/fs/node'
import { createLocalAgentMemoryRagStore } from '../../src/modules/agent/rag/memory.js'

test('owner-bound memory RAG reader only exposes known memory paths and refuses traversal or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-memory-'))
  const owner = randomUUID(), other = randomUUID()
  const scopedPath = join(root, owner, '.agent', 'im', 'qq', 'bot-1', 'groups', 'group%3A7')
  const outside = join(root, 'outside.md')
  try {
    await mkdir(scopedPath, { recursive: true })
    await mkdir(join(root, other, '.agent'), { recursive: true })
    await writeFile(join(root, owner, '.agent', 'daily.md'), '近期')
    await writeFile(join(root, owner, '.agent', 'summary.json'), '{"text":"本周状态"}')
    await writeFile(join(root, owner, '.agent', 'stance.json'), '{"stance":"闲聊"}')
    await writeFile(join(root, owner, '.agent', 'lens.json'), '{"rules":[]}')
    await writeFile(join(scopedPath, 'profile.json'), '{"text":"群组项目"}')
    await writeFile(join(root, other, '.agent', 'daily.md'), '异主正文')
    await writeFile(outside, '链接外部正文')
    await symlink(outside, join(root, owner, '.agent', 'memory.md'))

    const store = createLocalAgentMemoryRagStore(root)
    assert.equal(await store.readText({ ownerId: owner, key: `${owner}/.agent/daily.md`, maxChars: 2 }), '近期')
    assert.equal(await store.readText({ ownerId: owner, key: `${owner}/.agent/summary.json`, maxChars: 100 }), '{"text":"本周状态"}')
    assert.equal(await store.readText({ ownerId: owner, key: `${owner}/.agent/stance.json`, maxChars: 100 }), '{"stance":"闲聊"}')
    assert.equal(await store.readText({ ownerId: owner, key: `${owner}/.agent/lens.json`, maxChars: 100 }), '{"rules":[]}')
    assert.equal(await store.readText({ ownerId: owner, key: `${owner}/.agent/im/qq/bot-1/groups/group%3A7/profile.json`, maxChars: 100 }), '{"text":"群组项目"}')
    assert.equal(await store.readText({ ownerId: owner, key: `${owner}/.agent/profile.json`, maxChars: 100 }), null)
    await assert.rejects(store.readText({ ownerId: owner, key: `${other}/.agent/daily.md`, maxChars: 100 }), UnsafeLocalPathError)
    await assert.rejects(store.readText({ ownerId: owner, key: `${owner}/.agent/../outside.md`, maxChars: 100 }), UnsafeLocalPathError)
    await assert.rejects(store.readText({ ownerId: owner, key: `${owner}/.env`, maxChars: 100 }), UnsafeLocalPathError)
    await assert.rejects(store.readText({ ownerId: owner, key: `${owner}/.agent/memory.md`, maxChars: 100 }), UnsafeLocalPathError)
    await assert.rejects(store.readText({ ownerId: owner, key: `${owner}/.agent/daily.md`, maxChars: 0 }), UnsafeLocalPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
