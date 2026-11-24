import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPresentFileTool, createToolRegistry } from '@gugu/core/tools'
import { createWebAgentFilePresentPort } from '../../../../src/modules/agent/tools/files/present.js'
import { createMindFileReferenceResolver } from '../../../../src/modules/mind/file-references.js'
import { projectFileStorageKey } from '../../../../src/modules/files/paths.js'
import { personalFileStorageKey } from '../../../../src/modules/workspaces/roots.js'

test('Web 只为当前用户的真实路径签发文件链接，校验身份并拒绝数字文件 ID', { skip: process.platform !== 'linux' }, async () => {
  const ownerId = '00000000-0000-4000-8000-000000000001'
  const otherOwner = '00000000-0000-4000-8000-000000000002'
  const identity = { ownerId, sessionId: '14', runId: 'present-file-run' }
  const lease = { identity, token: 'synthetic', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { v: 2 as const, source: 'web' as const, userMessageId: 91, locale: 'zh-CN' as const, origin: 'browser-A', accessVersion: 'b'.repeat(64) } }
  const root = await mkdtemp(join(tmpdir(), 'gugu-file-link-'))
  try {
    const directory = join(root, personalFileStorageKey(ownerId))
    const otherDirectory = join(root, personalFileStorageKey(otherOwner))
    await mkdir(directory, { recursive: true })
    await mkdir(otherDirectory, { recursive: true })
    await writeFile(join(directory, 'voice.mp3'), '测试文件')
    await writeFile(join(otherDirectory, 'private.mp3'), '其他用户的测试文件')
    const project = { id: 12, name: '小北项目', start_date: '2026-11-20', created_at: '2026-11-20' }
    await mkdir(join(root, projectFileStorageKey(ownerId, project.id, project.name, project.start_date, project.created_at)), { recursive: true })
    const pool = { async query(statement: string, args: unknown[]) {
      assert.equal(args.at(-1), ownerId)
      return { rows: statement.includes('FROM projects') ? [project] : [] }
    } } as never
    let authorized = true
    const registry = createToolRegistry({
      authorize: async () => authorized,
      tools: [createPresentFileTool(createWebAgentFilePresentPort({ pool, ownerId, lease, storageRoot: root }))],
    })
    const dispatch = (input: unknown, current = identity) => registry.tools.dispatch({ id: 'file', name: 'open_item', input }, {
      identity: current, roundId: '2', signal: new AbortController().signal, resolution: null,
      async execute() { throw new Error('文件展示不得执行宿主命令') },
    })
    const result = await dispatch({ kind: 'file', item: '/personal/voice.mp3' })
    assert.ok(result.kind === 'completed' && result.successful)
    const { link } = result.value as { link: string }
    assert.match(link, /^gugu:\/\/open-object\/file\/path-/u)
    const folder = await dispatch({ kind: 'folder', item: project.name })
    assert.ok(folder.kind === 'completed' && folder.successful)
    assert.match((folder.value as { link: string }).link, /^gugu:\/\/open-object\/folder\/path-/u)

    const token = link.split('/').at(-1)!
    const resolve = createMindFileReferenceResolver(pool, root)
    assert.equal((await resolve(ownerId, token))?.label, 'voice.mp3')
    assert.equal(await resolve(otherOwner, token), null)
    await rename(join(directory, 'voice.mp3'), join(directory, 'backup.mp3'))
    await writeFile(join(directory, 'voice.mp3'), '替换文件')
    assert.equal(await resolve(ownerId, token), null)
    const rejected = async (input: unknown, current = identity) => {
      const outcome = await dispatch(input, current)
      assert.ok(outcome.kind === 'completed' && !outcome.successful)
    }
    await mkdir(join(directory, project.name))
    await rejected({ kind: 'folder', item: project.name })
    const exactFolder = await dispatch({ kind: 'folder', item: '/personal/' + project.name })
    assert.ok(exactFolder.kind === 'completed' && exactFolder.successful)
    await rejected({ kind: 'file', item: '/personal/private.mp3' })
    await rejected({ kind: 'file', item: '/personal/voice.mp3' }, { ...identity, ownerId: otherOwner })
    await rejected({ file_id: 7 })
    authorized = false
    await rejected({ kind: 'file', item: '/personal/voice.mp3' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
