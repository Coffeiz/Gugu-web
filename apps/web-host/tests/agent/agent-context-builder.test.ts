import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgentContextBuilder, agentCurrentTimeReminderBody } from '../../src/domains/agent-sessions/context/agent-context-builder.js'
import { prepareContext } from '@gugu/core/agent'
import type { ContextData, ContextSourceSelection } from '@gugu/core/agent'

test('可信快照固定在前缀，时区时间进入动态尾且不污染静态提示', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }, now = new Date('2026-01-01T16:30:00Z')
  const selection = { modelIdentity: 'model', contextWindow: 10000, locale: 'zh-CN', groupChat: false, workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } } satisfies ContextSourceSelection
  const data = { projects: [], userTimezone: 'Asia/Shanghai', events: [], notes: [], filesOverview: {}, stylePreferences: {}, memory: {}, imChannels: {}, imMemory: {}, knowledge: [] } satisfies ContextData
  const builder = createAgentContextBuilder({
    staticPrompt: () => ({ base: '今天 {today}', persona: '人格', skills: '', policy: '策略', retrieval: '', skillIndex: '', timezone: data.userTimezone, now }),
    dynamic: () => ({ memoryBlock: '记忆', projectBlock: '项目', sourceBlock: '来源', events: [], notes: [], files: null, knowledge: [], includeProjects: true, includeCalendar: true, includeFiles: true, includeKnowledge: true }),
    sessionInfo: () => ({ source: 'web' }), systemInMessages: () => true,
  })
  const snapshot = builder.buildSnapshot(data, selection, identity)
  const request = builder.buildRequest({ ...snapshot, imChannels: {}, imMemory: {}, memorySummaryHash: '', ragRevision: '', snapshotHash: '', historyBaselineMessageSeq: 0, workspaceBinding: {} }, selection, identity)
  const prepared = await prepareContext({ ...identity, fixedPrefix: request.fixedPrefix, systemPrompt: request.systemPrompt, systemInMessages: request.systemInMessages, history: [], preparedRag: { tail: [] }, currentUser: { persistedMessageId: '1', message: { role: 'user', content: '你好' } }, extraReminder: agentCurrentTimeReminderBody(now, data.userTimezone) }, { digest: () => 'digest', nextId: () => 'id', buildRag: async () => ({ tail: [] }) })
  assert.match(JSON.stringify(prepared.area.requestPrefix), /记忆/)
  assert.doesNotMatch(JSON.stringify(prepared.area.requestPrefix), /00:30/)
  assert.match(JSON.stringify(prepared.area.dynamicTail), /00:30/)
  assert.match(request.systemPrompt, /2026-01-02（星期五）/)
})
