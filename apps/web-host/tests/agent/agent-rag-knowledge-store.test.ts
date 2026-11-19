import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { UnsafeLocalPathError } from '@gugu/fs/node'
import { createLocalAgentKnowledgeReadStore } from '../../src/modules/agent-sessions/tools/agent-rag-knowledge-store.js'

test('owner-bound knowledge FS reader pages Markdown, excludes other files and rejects traversal/symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-knowledge-'))
  const owner = randomUUID(), directory = join(root, owner, '.agent', 'knowledge'), entries = join(directory, 'entries')
  const outside = join(root, 'outside.md')
  try {
    await mkdir(entries, { recursive: true })
    await writeFile(join(directory, '.timestamps-iso-v1'), '')
    await writeFile(join(entries, 'a.md'), '知识甲')
    await writeFile(join(entries, 'b.md'), '知识乙')
    await writeFile(join(entries, 'ignored.txt'), '忽略文本')
    await writeFile(outside, '不能跟随符号链接')
    await symlink(outside, join(entries, 'linked.md'))

    const store = createLocalAgentKnowledgeReadStore(root)
    assert.equal(await store.exists(`${owner}/.agent/knowledge/.timestamps-iso-v1`), true)
    const first = await store.list(`${owner}/.agent/knowledge/entries/`, null, 1)
    assert.deepEqual(first, { keys: [`${owner}/.agent/knowledge/entries/a.md`], nextCursor: 'a.md' })
    const second = await store.list(`${owner}/.agent/knowledge/entries/`, first.nextCursor, 1)
    assert.deepEqual(second, { keys: [`${owner}/.agent/knowledge/entries/b.md`], nextCursor: null })
    assert.deepEqual(await store.read(first.keys[0]!), new TextEncoder().encode('知识甲'))
    assert.equal(await store.exists(`${randomUUID()}/.agent/knowledge/.timestamps-iso-v1`), false)
    await assert.rejects(store.read(`${owner}/.agent/knowledge/entries/../outside.md`), UnsafeLocalPathError)
    await assert.rejects(store.read(`${owner}/.agent/knowledge/entries/linked.md`), UnsafeLocalPathError)
    await assert.rejects(store.list(`${owner}/.agent/knowledge/entries/`, '../a.md', 10), UnsafeLocalPathError)

    await rm(entries, { recursive: true })
    await symlink(join(root, 'elsewhere'), entries)
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    await writeFile(join(root, 'elsewhere', 'leak.md'), '不得读取')
    await assert.rejects(store.list(`${owner}/.agent/knowledge/entries/`, null, 10), UnsafeLocalPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
