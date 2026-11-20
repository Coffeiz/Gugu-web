import assert from 'node:assert/strict'
import test from 'node:test'
import { createPresentFileTool, createToolRegistry, type FilePathCandidate } from '@gugu/core/tools'
import { createWebAgentFilePresentPort } from '../../src/modules/agent/tools/files/present.js'

test('present_file 经 Web lease 与 Core Registry 只返回 owner 文件预览指令', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000001'
  const identity = { ownerId, sessionId: '14', runId: 'present-file-run' }
  const lease = { identity, token: 'synthetic', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { v: 2 as const, source: 'web' as const, userMessageId: 91, locale: 'zh-CN', origin: 'browser-A', accessVersion: 'b'.repeat(64) } }
  const otherOwner = '00000000-0000-4000-8000-000000000002'
  const rows = new Map<number, Record<string, unknown>>([
    [7, { id: 7, user_id: ownerId, storage_key: `${ownerId}/personal/voice.mp3`, display_name: 'voice', ext: 'mp3' }],
    [8, { id: 8, user_id: otherOwner, storage_key: `${otherOwner}/personal/private.mp3`, display_name: 'private', ext: 'mp3' }],
  ])
  const pool = { async query(_sql: string, values: unknown[]) {
    const row = rows.get(Number(values[0]))
    if (!row || values[1] !== ownerId || row.user_id !== values[1]) return { rowCount: 0, rows: [] }
    return { rowCount: 1, rows: [row] }
  } }
  const candidates: FilePathCandidate[] = [{ file_id: 7, name: 'voice.mp3', path: '/personal/voice.mp3' }]
  let authorized = true
  const registry = createToolRegistry({ authorize: async (current, name) => authorized && current.ownerId === ownerId && name === 'present_file',
    tools: [createPresentFileTool(createWebAgentFilePresentPort({ pool, ownerId, lease,
      files: { async list(current, signal) { signal.throwIfAborted(); assert.deepEqual(current, identity); return candidates } },
    }))] })
  const dispatch = (input: unknown, current = identity) => registry.tools.dispatch({ id: 'present-file', name: 'present_file', input }, {
    identity: current, roundId: '2', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('文件展示不得执行宿主命令') },
  })

  assert.deepEqual(await dispatch({ file_id: 7 }), { kind: 'completed', successful: true, mutated: false,
    value: { ok: true, message: '已在当前浏览器打开《voice.mp3》。', file_id: 7, name: 'voice', ext: 'mp3' } })
  assert.deepEqual(await dispatch({ file: '/personal/voice.mp3' }), { kind: 'completed', successful: true, mutated: false,
    value: { ok: true, message: '已在当前浏览器打开《voice.mp3》。', file_id: 7, name: 'voice', ext: 'mp3' } })
  assert.match(JSON.stringify(await dispatch({ file: 'file:///private/voice.mp3' })), /不接受 file:\/\//u)
  assert.equal((await dispatch({ file_id: 7, file: '/personal/voice.mp3' })).successful, false)
  assert.equal((await dispatch({ file_id: 8 })).successful, false)
  assert.equal((await dispatch({ file_id: 7 }, { ...identity, ownerId: '00000000-0000-4000-8000-000000000002' })).successful, false)
  authorized = false
  assert.equal((await dispatch({ file_id: 7 })).successful, false)
})
