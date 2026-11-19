import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEditFileTool, createToolRegistry } from '@gugu/core/tools'
import { createWebAgentFileEditPort } from '../../src/modules/agent/tools/files/edit.js'

test('edit_file 经 per-lease Host 逻辑路径解析、owner 查询和文件内容事务执行行修改', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-file-edit-'))
  const ownerId = '00000000-0000-4000-8000-000000000001'
  const storageKey = `${ownerId}/notes.txt`
  const identity = { ownerId, sessionId: '12', runId: 'run-edit' }
  const lease = { identity, token: 'synthetic', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { v: 2 as const, source: 'web' as const, accessVersion: 'a'.repeat(64), userMessageId: 1, locale: 'zh-CN' as const, origin: null } }
  let version = 3
  let listCalls = 0
  try {
    await mkdir(join(root, ownerId), { recursive: true })
    await writeFile(join(root, storageKey), '第一行\n第二行\n')
    const port = createWebAgentFileEditPort({
      async query() { return { rows: [{ id: 7, user_id: ownerId, storage_key: storageKey, display_name: 'notes', ext: 'txt', mime_type: 'text/plain', version }] } }
    } as never, root, {
      async update(owner, id, content, expectedVersion, metadata) {
        assert.equal(owner, ownerId); assert.equal(id, 7); assert.equal(expectedVersion, version)
        assert.equal(metadata.undoContextId, `agent:${identity.sessionId}:${identity.runId}`)
        await writeFile(join(root, storageKey), content)
        return { version: ++version, sizeBytes: Buffer.byteLength(content) }
      },
    }, lease, {
      async list(current, signal) {
        listCalls++
        signal.throwIfAborted()
        assert.deepEqual(current, identity)
        return [{ file_id: 7, name: 'notes.txt', space: 'personal' as const, path: '/personal/notes.txt', project_id: null,
          folder_id: null, workspace_directory_id: null, size_bytes: 18, is_text: true }]
      },
    })
    const registry = createToolRegistry({ authorize: async () => true, tools: [createEditFileTool(port)] })
    const dispatch = (input: unknown, current = identity) => registry.tools.dispatch({ id: 'edit', name: 'edit_file', input }, {
      identity: current, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('文件编辑不得执行宿主命令') },
    })
    const edited = await dispatch({ file: '/personal/notes.txt', mode: 'line_edit', line_edits: [
      { target_lines: '2', expected: '第二行', content: '替换行' },
    ] })
    assert.equal(edited.successful, true)
    assert.equal(await readFile(join(root, storageKey), 'utf8'), '第一行\n替换行\n')
    assert.equal(listCalls, 1)
    const traversal = await dispatch({ file: '/personal/../secret.txt', mode: 'append', content: 'x' })
    assert.equal(traversal.successful, false)
    assert.equal(listCalls, 1)
    const revokedIdentity = { ...identity, ownerId: '00000000-0000-4000-8000-000000000002' }
    const revoked = await dispatch({ file: '/personal/notes.txt', mode: 'append', content: 'x' }, revokedIdentity)
    assert.equal(revoked.successful, false)
    assert.equal(listCalls, 1)
    await writeFile(join(root, storageKey), '超大正文'.repeat(40_000))
    const tooLarge = await dispatch({ file_id: 7, operation: 'append', content: 'x' })
    assert.equal(tooLarge.successful, false)
    assert.match(JSON.stringify(tooLarge.value), /256KB/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
