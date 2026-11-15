import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createCoreAgentConversationSearchPort } from '../../src/domains/agent-sessions/tools/agent-conversations.js'

test('search_conversations 经生产 Host 适配器和真实工具分派查询 owner 限定的会话事实表', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-conversation-search-'))
  const path = join(folder, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId
    // 会话表由 Host Agent schema 管理，Core Data 的业务表型不包含它们；只在 fixture 侧声明实际插入列。
    // 正式 SQLite runtime 只允许本地 owner；跨 owner 记录由隔离 PostgreSQL 用例覆盖，本用例验证工具输入不能伪造 owner。
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values([
      { id: 1, user_id: owner.replaceAll('-', ''), title: '部署讨论', title_locked: 0, summary: '发布窗口', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 10, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z' },
      { id: 2, user_id: owner.replaceAll('-', ''), title: '群聊排除', title_locked: 0, summary: '群聊命中不得进入个人搜索', source: 'im', chat_type: 'group', context_epoch: 0, baseline_message_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-03T03:04:00Z' },
    ]).execute()
    await fixtureDb.insertInto('conversation_messages').values([
      { session_id: 1, conversation_seq: 1, role: 'user', content: '请准备周五部署发布。', created_at: '2026-01-02T03:00:00Z' },
      { session_id: 2, conversation_seq: 1, role: 'user', content: '群里的部署凭据。', created_at: '2026-01-03T03:00:00Z' },
      { session_id: 1, conversation_seq: 2, role: 'user', content: '历史 literal 100%_完成。', created_at: '2026-01-02T04:00:00Z' },
      { session_id: 1, conversation_seq: 3, role: 'tool', content: '工具正文 100%_完成 不得命中。', created_at: '2026-01-02T05:00:00Z' },
    ]).execute()

    // 固定切词只用来隔离验证工具接线；生产分词器尚须由 Host 装配正式 rjieba 依赖。
    const conversationSearch = createCoreAgentConversationSearchPort(runtime, { cut: text => [text] })
    let authorized = true
    const registry = createAgentToolRegistry({ core: runtime, conversationSearch, authorize: async () => authorized })
    const identity = { ownerId: owner, sessionId: '90', runId: 'synthetic-run' }
    const scope = {
      identity,
      roundId: '1',
      signal: new AbortController().signal,
      resolution: null,
      execute: async () => { throw new Error('只读工具不得调用执行后端') },
    }

    const result = await registry.tools.dispatch({ id: 'search-1', name: 'search_conversations', input: { query: '部署', owner_id: randomUUID() } }, scope)
    assert.equal(result.kind, 'completed')
    assert.equal(result.kind === 'completed' && result.successful, true)
    assert.deepEqual(result.kind === 'completed' ? (result.value as { matches: Array<{ session_id: number; match: { snippet: string } }> }).matches.map(row => ({ session_id: row.session_id, snippet: row.match.snippet })) : [], [
      { session_id: 1, snippet: '部署讨论\n发布窗口\n请准备周五部署发布。' },
    ])
    const andResult = await registry.tools.dispatch({ id: 'and-1', name: 'search_conversations', input: { queries: ['部署', '发布'], mode: 'AND' } }, scope)
    assert.equal(andResult.kind === 'completed' && andResult.successful, true)
    assert.deepEqual(andResult.kind === 'completed' ? (andResult.value as { matches: Array<{ session_id: number }> }).matches.map(row => row.session_id) : [], [1])
    const noMatch = await registry.tools.dispatch({ id: 'and-2', name: 'search_conversations', input: { queries: ['部署', '不存在'], mode: 'AND' } }, scope)
    assert.equal(noMatch.kind === 'completed' && noMatch.successful, true)
    assert.deepEqual(noMatch.kind === 'completed' ? (noMatch.value as { matches: unknown[] }).matches : [], [])

    // Python 基准允许搜索被 baseline 压缩前仍保留的历史，并把 SQL LIKE 元字符视作字面词。
    const literalHistory = await registry.tools.dispatch({ id: 'literal-1', name: 'search_conversations', input: { queries: ['100%_完成'] } }, scope)
    assert.equal(literalHistory.kind === 'completed' && literalHistory.successful, true)
    assert.deepEqual(literalHistory.kind === 'completed' ? (literalHistory.value as { matches: Array<{ session_id: number; match: { snippet: string } }> }).matches.map(row => ({ session_id: row.session_id, snippet: row.match.snippet })) : [], [
      { session_id: 1, snippet: '部署讨论\n发布窗口\n历史 literal 100%_完成。' },
    ])
    authorized = false
    const denied = await registry.tools.dispatch({ id: 'denied-1', name: 'search_conversations', input: { query: '部署' } }, scope)
    assert.equal(denied.kind === 'completed' && denied.successful, false)
    assert.doesNotMatch(JSON.stringify(denied), /部署讨论|请准备周五/)
    authorized = true

    const recent = await registry.tools.dispatch({ id: 'recent-1', name: 'search_conversations', input: {} }, scope)
    assert.equal(recent.kind, 'completed')
    assert.deepEqual(recent.kind === 'completed' ? (recent.value as { recent: Array<{ session_id: number }> }).recent.map(row => row.session_id) : [], [2, 1])
    const invalid = await registry.tools.dispatch({ id: 'invalid-1', name: 'search_conversations', input: { query: '部署', queries: ['发布'] } }, scope)
    assert.equal(invalid.kind === 'completed' && invalid.successful, false)
  } finally {
    await runtime?.close()
    await rm(folder, { recursive: true, force: true })
  }
})
