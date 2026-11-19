import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { CoreError } from '@gugu/core'
import { createCreateFileTool, createToolRegistry } from '@gugu/core/tools'
import type { FileUploadOperations } from '../../src/modules/files/upload.js'
import { createWebAgentFileCreatePort } from '../../src/modules/agent/tools/files/create.js'

test('批量 create_file 经 Core Registry、Web lease 与 Node 上传端口逐项创建并恢复收据', async () => {
  const ownerId = randomUUID(), identity = { ownerId, sessionId: '12', runId: 'create-batch-run' }
  const lease = { identity, token: 'create-token', fence: 3, mode: 'start' as const, cancelRequested: false,
    input: { v: 2 as const, source: 'web' as const, accessVersion: 'c'.repeat(64), userMessageId: 1, locale: 'zh-CN' as const, origin: null } }
  const pool = { async query() { return { rowCount: 1, rows: [{}] } } }
  const receipts = new Map<string, Record<string, unknown>>()
  let stores = 0, authorizationCalls = 0
  const upload: FileUploadOperations = {
    async getUploadCapacity(owner, input) {
      assert.equal(owner, ownerId)
      assert.equal(input.space, 'personal')
      return 1024 * 1024
    },
    async store(owner, staged, metadata, operation) {
      stores++
      assert.equal(owner, ownerId)
      assert.equal(metadata.undoContextId, `agent:${identity.sessionId}:${identity.runId}`)
      assert.equal((await readFile(staged.path)).toString('utf8'), staged.originalName === '坏.txt' ? '坏' : '正文')
      assert.equal(operation?.receipt.method, 'agent.file.create')
      await operation?.authorize({ async query(sql: string, values: unknown[]) {
        authorizationCalls++
        assert.match(sql, /agent_run_dispatch/u)
        assert.deepEqual(values, [ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
        return pool.query()
      } } as never)
      if (staged.originalName === '坏.txt') throw new CoreError('invalid_request', '目标目录不可写')
      const previous = receipts.get(operation!.receipt.operationId)
      if (previous) return { file: previous, replayed: true }
      const dot = staged.originalName.lastIndexOf('.')
      const file = { id: receipts.size + 1, displayName: staged.originalName.slice(0, dot), ext: staged.originalName.slice(dot + 1), sizeBytes: staged.sizeBytes }
      receipts.set(operation!.receipt.operationId, file)
      return { file, replayed: false }
    },
  }
  const port = createWebAgentFileCreatePort({ pool: pool as never, upload, lease })
  const registry = createToolRegistry({ authorize: async (current, name) => current.ownerId === ownerId && name === 'create_file', tools: [createCreateFileTool(port)] })
  const call = { id: 'create-files', name: 'create_file', input: { target: { space: 'personal' }, files: [
    { filename: '一.txt', content: '正文' }, { filename: '坏.txt', content: '坏' },
    { filename: '二.txt', content: '正文' },
  ] } }
  const scope = { identity, roundId: 'batch-round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('文件创建不得执行宿主 Shell') } }
  const first = await registry.tools.dispatch(call, scope)
  assert.deepEqual(first, { kind: 'completed', successful: true, mutated: true, value: {
    success: true, created_count: 2, failed_count: 1,
    created: [
      { index: 0, file_id: 1, name: '一.txt', size_bytes: 6, mutated: true },
      { index: 2, file_id: 2, name: '二.txt', size_bytes: 6, mutated: true },
    ], failed: [{ index: 1, name: '坏.txt', error: '目标目录不可写' }],
  } })
  const replay = await registry.tools.dispatch(call, scope)
  assert.equal(replay.kind === 'completed' && replay.mutated, false)
  assert.equal(stores, 6)
  assert.equal(authorizationCalls, 6)
})
