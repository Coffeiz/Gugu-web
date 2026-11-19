import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PoolClient } from 'pg'
import { createPostgresWebAgentChatPreparation } from '../../src/modules/agent-sessions/persistence/agent-web-chat-preparation.js'

function fixture(options: { attachmentClaimFails?: boolean; project?: Record<string, unknown> | null; mcp?: Record<string, unknown> | null } = {}) {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  let attachmentState = 'draft'
  const client = {
    async query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: null, rows: [] }
      if (sql.includes('SELECT id FROM users')) return { rowCount: 1, rows: [{ id: values[0] }] }
      if (sql.includes('SELECT id FROM conversation_sessions')) return { rowCount: 1, rows: [{ id: 7 }] }
      if (sql.includes('INSERT INTO conversation_sessions')) return { rowCount: 1, rows: [{ id: 7 }] }
      if (sql.includes('INSERT INTO agent_run_startups')) return { rowCount: 1, rows: [] }
      if (sql.includes('SELECT id,name,status,contact_name,progress,current_stage FROM projects WHERE')) return { rowCount: options.project ? 1 : 0, rows: options.project ? [options.project] : [] }
      if (sql.includes('FROM user_mcp_servers WHERE')) return { rowCount: options.mcp ? 1 : 0, rows: options.mcp ? [options.mcp] : [] }
      if (sql.includes('FROM chat_attachments WHERE')) return { rowCount: 1, rows: [{
        attach_id: 'owned-file', name: '计划', ext: 'txt', mime: 'text/plain', size: '12', storage_key: 'private-key',
        kind: 'text', duration: null, img_width: null, img_height: null, extra: { qq_face: true, quoted: false },
      }] }
      if (sql.startsWith('UPDATE conversation_sessions SET last_message_seq')) return { rowCount: 1, rows: [{ last_message_seq: '1' }] }
      if (sql.includes('INSERT INTO conversation_messages')) return { rowCount: 1, rows: [{ id: 55 }] }
      if (sql.includes('UPDATE chat_attachments SET state=')) {
        if (options.attachmentClaimFails || attachmentState !== 'draft') return { rowCount: 0, rows: [] }
        attachmentState = 'attached'
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('FROM conversation_messages m JOIN conversation_sessions s')) return { rowCount: 1, rows: [] }
      if (sql.includes('INSERT INTO agent_run_dispatch')) return { rowCount: 1, rows: [] }
      if (sql.includes('UPDATE conversation_sessions SET pending_message_count')) return { rowCount: 1, rows: [] }
      return { rowCount: 1, rows: [] }
    },
    release() {},
  } as unknown as PoolClient
  const prepare = createPostgresWebAgentChatPreparation({ async connect() { return client } }, {
    dispatchSecret: 'synthetic-dispatch-secret', dispatchTtlSeconds: 60,
  })
  return { prepare, statements }
}

test('Web 准备工厂在同一事务内按 owner 解析并 claim 附件，再持久化 dispatch', async () => {
  const value = fixture()
  const result = await value.prepare('owner-a', { message: '继续', attachments: ['owned-file', 'foreign-or-missing'] }, 'run-a', {
    mode: 'dispatch', origin: null, accessVersion: 'a'.repeat(64), ttlSeconds: 60,
  })
  assert.deepEqual(result, { sessionId: 7, userMessageId: 55, isNew: true, runId: 'run-a' })
  const attachmentRead = value.statements.find(item => item.sql.includes('FROM chat_attachments WHERE'))!
  assert.deepEqual(attachmentRead.values, ['owner-a', ['owned-file', 'foreign-or-missing']])
  const message = value.statements.find(item => item.sql.includes('INSERT INTO conversation_messages'))!
  const cards = JSON.parse(String(message.values[4])) as Array<Record<string, unknown>>
  assert.deepEqual(cards, [{ attach_id: 'owned-file', name: '计划', ext: 'txt', size_bytes: '12', kind: 'text', mime: 'text/plain', qq_face: true, quoted: false, upload: true, duration: null, img_width: null, img_height: null }])
  assert.equal(JSON.stringify(cards).includes('private-key'), false)
  assert.ok(value.statements.some(item => item.sql.includes('UPDATE chat_attachments SET state=')))
  assert.ok(value.statements.some(item => item.sql.includes('INSERT INTO agent_run_dispatch')))
  assert.ok(value.statements.some(item => item.sql === 'COMMIT'))
  assert.ok(!value.statements.some(item => item.sql === 'ROLLBACK'))
})

test('附件在 claim 前失效时 Web 消息及 dispatch 不提交', async () => {
  const value = fixture({ attachmentClaimFails: true })
  await assert.rejects(value.prepare('owner-a', { message: '继续', attachments: ['owned-file'] }, 'run-b', {
    mode: 'dispatch', origin: null, accessVersion: 'b'.repeat(64), ttlSeconds: 60,
  }), /附件已失效/)
  assert.ok(value.statements.some(item => item.sql === 'ROLLBACK'))
  assert.ok(!value.statements.some(item => item.sql.includes('INSERT INTO agent_run_dispatch')))
  assert.ok(!value.statements.some(item => item.sql === 'COMMIT'))
})

test('Web 消息通过同一 owner 事务解析引用正文，并保留独立展示引用', async () => {
  const value = fixture({ project: { id: 4, name: '项目甲', status: 'active', contact_name: null, progress: 35, current_stage: null } })
  await value.prepare('owner-a', { message: '进展如何？', references: [{ type: 'project', id: 4, label: '展示标题' }] }, 'run-c', {
    mode: 'dispatch', origin: null, accessVersion: 'c'.repeat(64), ttlSeconds: 60,
  })
  const lookup = value.statements.find(item => item.sql.includes('FROM projects WHERE'))!
  assert.deepEqual(lookup.values, [4, 'owner-a'])
  const insert = value.statements.find(item => item.sql.includes('INSERT INTO conversation_messages'))!
  assert.deepEqual(JSON.parse(String(insert.values[5])), [{ type: 'project', id: 4, label: '展示标题' }])
  const canonical = JSON.parse(String(insert.values[6])) as Array<{ type: string; scope?: string; text?: string }>
  assert.deepEqual(canonical.map(item => item.type), ['knowledge-context', 'text'])
  assert.equal(canonical[0]?.scope, 'explicit-reference')
  assert.match(canonical[0]?.text ?? '', /项目甲/)
  assert.match(canonical[1]?.text ?? '', /进展如何/)
  assert.doesNotMatch(canonical[0]?.text ?? '', /展示标题/)
})

test('其他 owner 或已删除的业务引用不会进入 Web 消息上下文', async () => {
  const value = fixture()
  await value.prepare('owner-a', { message: '读取项目', references: [{ type: 'project', id: 404 }] }, 'run-d', {
    mode: 'dispatch', origin: null, accessVersion: 'd'.repeat(64), ttlSeconds: 60,
  })
  const lookup = value.statements.find(item => item.sql.includes('FROM projects WHERE'))!
  assert.deepEqual(lookup.values, [404, 'owner-a'])
  const insert = value.statements.find(item => item.sql.includes('INSERT INTO conversation_messages'))!
  assert.equal(insert.values[6], null)
  assert.deepEqual(JSON.parse(String(insert.values[5])), [{ type: 'project', id: 404 }])
})

test('MCP 引用只返回 owner/platform 元数据，不暴露 endpoint 或凭据', async () => {
  const id = '018f2a10-aaaa-7bbb-8ccc-0123456789ab'
  const value = fixture({ mcp: { id, name: '知识服务', scope: 'user', enabled: false, tool_allowlist: ['lookup'] } })
  await value.prepare('owner-a', { message: '这个服务做什么？', references: [{ type: 'mcp', id: id.toUpperCase() }] }, 'run-e', {
    mode: 'dispatch', origin: null, accessVersion: 'e'.repeat(64), ttlSeconds: 60,
  })
  const lookup = value.statements.find(item => item.sql.includes('FROM user_mcp_servers WHERE'))!
  assert.deepEqual(lookup.values, [id, 'owner-a'])
  assert.match(lookup.sql, /scope='user'.*scope='platform'/)
  assert.doesNotMatch(lookup.sql, /endpoint|credential|secret/i)
  const insert = value.statements.find(item => item.sql.includes('INSERT INTO conversation_messages'))!
  const canonical = JSON.parse(String(insert.values[6])) as Array<{ text?: string }>
  assert.match(canonical[0]?.text ?? '', /MCP 服务 id：/)
  assert.match(canonical[0]?.text ?? '', /知识服务/)
  assert.match(canonical[0]?.text ?? '', /已停用/)
  assert.match(canonical[0]?.text ?? '', /lookup/)
  assert.doesNotMatch(canonical[0]?.text ?? '', /endpoint|credential|secret/i)
})

test('foreign user MCP 引用按 owner 隔离，platform MCP 引用可读', async () => {
  const id = '018f2a10-aaaa-7bbb-8ccc-0123456789ab'
  const foreign = fixture()
  await foreign.prepare('owner-a', { message: '查看 MCP', references: [{ type: 'mcp', id }] }, 'run-f', {
    mode: 'dispatch', origin: null, accessVersion: 'f'.repeat(64), ttlSeconds: 60,
  })
  const foreignMessage = foreign.statements.find(item => item.sql.includes('INSERT INTO conversation_messages'))!
  assert.equal(foreignMessage.values[6], null)

  const platform = fixture({ mcp: { id, name: '平台服务', scope: 'platform', enabled: true, tool_allowlist: [] } })
  await platform.prepare('owner-a', { message: '查看平台 MCP', references: [{ type: 'mcp', id }] }, 'run-g', {
    mode: 'dispatch', origin: null, accessVersion: '1'.repeat(64), ttlSeconds: 60,
  })
  const lookup = platform.statements.find(item => item.sql.includes('FROM user_mcp_servers WHERE'))!
  assert.deepEqual(lookup.values, [id, 'owner-a'])
  const insert = platform.statements.find(item => item.sql.includes('INSERT INTO conversation_messages'))!
  const canonical = JSON.parse(String(insert.values[6])) as Array<{ text?: string }>
  assert.match(canonical[0]?.text ?? '', /平台服务/)
  assert.match(canonical[0]?.text ?? '', /全部工具/)
})
