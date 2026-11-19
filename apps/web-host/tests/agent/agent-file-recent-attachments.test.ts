import assert from 'node:assert/strict'
import test from 'node:test'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/modules/agent/tools/registry.js'
import { createWebAgentRecentAttachmentsPort } from '../../src/modules/agent/tools/files/recent.js'

const identity = { ownerId: 'owner-synthetic', sessionId: '41', runId: 'recent-attachments-synthetic' }
const lease = { identity, token: 'lease-synthetic', fence: 3, mode: 'start', cancelRequested: false,
  input: { v: 2, source: 'web' } } as never

test('近期附件经 Host adapter 和真实 ToolRegistry dispatch 按 owner/session 返回元数据', async () => {
  const queries: Array<{ text: string; values: unknown[] }> = []
  const pool = { async query(text: string, values: unknown[] = []) {
    queries.push({ text, values })
    if (text.includes("state='draft'")) return { rows: [{ attach_id: 'draft-id', name: '草稿.jpg', ext: 'jpg', kind: 'image',
      platform: 'web', size: '123', img_width: 20, img_height: 10, duration: null, created_at: '2026-01-01T00:00:00Z' }] }
    return { rows: [{ attach_id: 'attached-id', name: '语音.ogg', ext: 'ogg', kind: 'audio', platform: 'web',
      size: 456, img_width: null, img_height: null, duration: 2.5, created_at: '2026-01-01T00:00:00Z' }] }
  } }
  const port = createWebAgentRecentAttachmentsPort(pool as never, lease, () => Date.parse('2026-01-01T00:30:00Z'))
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, recentAttachments: port,
    authorize: async (current, name) => current.ownerId === identity.ownerId && current.sessionId === identity.sessionId && name === 'list_recent_attachments' })
  const result = await registry.tools.dispatch({ id: 'recent-call', name: 'list_recent_attachments', input: {} }, {
    identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('附件列表不能访问执行后端') },
  })
  assert.deepEqual(queries.map(query => query.values), [[identity.ownerId], [identity.ownerId, Number(identity.sessionId)]])
  assert.match(queries[1]!.text, /s\.user_id=a\.user_id/u)
  assert.match(queries[1]!.text, /s\.id=\$2/u)
  assert.equal(result.kind, 'completed')
  if (result.kind !== 'completed') return
  assert.equal(result.successful, true)
  assert.deepEqual(result.value, {
    count: 2,
    items: [
      { attach_id: 'draft-id', name: '草稿.jpg', ext: 'jpg', kind: 'image', platform: 'web', size_bytes: 123,
        img_width: 20, img_height: 10, state: 'draft', staged_about: '约5天前' },
      { attach_id: 'attached-id', name: '语音.ogg', ext: 'ogg', kind: 'audio', platform: 'web', size_bytes: 456,
        img_width: null, img_height: null, duration: 2.5, state: 'attached' },
    ],
    note: '已挂载附件可通过 save_uploaded_file 保存到文件库；媒体读取能力由当前 Host 提供。',
  })
  assert.doesNotMatch(JSON.stringify(result), /storage_key|private_path|secret/u)
})

test('近期附件 adapter 在查询前拒绝其他 owner/session/run、非 Web lease 和取消', async () => {
  let queries = 0
  const pool = { async query() { queries++; return { rows: [] } } }
  const port = createWebAgentRecentAttachmentsPort(pool as never, lease)
  const signal = new AbortController().signal
  await assert.rejects(port.list({ ...identity, ownerId: 'other-owner' }, signal), /身份不匹配/u)
  await assert.rejects(port.list({ ...identity, sessionId: '42' }, signal), /身份不匹配/u)
  await assert.rejects(port.list({ ...identity, runId: 'other-run' }, signal), /身份不匹配/u)
  assert.equal(queries, 0)
  assert.throws(() => createWebAgentRecentAttachmentsPort(pool as never,
    { ...lease, input: { v: 2, source: 'telegram' } } as never), /来源无法验证/u)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(port.list(identity, controller.signal), /abort/iu)
  assert.equal(queries, 0)
})
