import { desktopFileReferenceKey, readDesktopTurnReferences, resolveDesktopChatReferences } from '../../../src/agent/sessions/desktop-references.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createDesktopAgentSession, readDesktopAgentMessages } from '../../../src/agent/sessions/desktop.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from '../../../src/agent/run/sqlite-store.js'
import { createDesktopAgentEventReader } from '../../../src/runtime/desktop-agent-events.js'
import { createSqliteRememberMemory } from '../../../src/agent/memory/sqlite.js'
import { applyRememberEdit } from '../../../src/agent/memory/remember.js'
import { settleExclusiveSqliteAgentRuns } from '../../../src/agent/run/sqlite-recovery.js'
import { loadSqliteAgentRunSecret } from '../../../src/agent/run/sqlite-secret.js'
import { createSqliteAgentPersistence, createSqliteAgentRuntime } from '../../../src/agent/run/sqlite-runtime.js'
import { createSqliteAgentAdmission } from '../../../src/agent/run/sqlite-admission.js'
import { createSqliteAgentRunCoordination } from '../../../src/agent/run/sqlite-coordination.js'
import { applySqliteAgentSnapshot, createSqliteAgentSessionSource } from '../../../src/agent/context/sqlite-source.js'
import { prepareContext } from '../../../src/agent/context/assemble.js'
import { selectSessionHistory, restoreHistoryForRequest } from '../../../src/agent/context/history/ordering.js'
import { formatAgentHistoryMessageTime } from '../../../src/agent/context/history/time.js'
import { contentText } from '../../../src/agent/context/compaction.js'
import { MessageArea, stableJson } from '../../../src/agent/context/history/canonical-history.js'
import { createConversationRagSource } from '../../../src/agent/rag/conversation-index-source.js'
import { createSqlRagRebuildWorker } from '../../../src/agent/rag/rebuild-worker.js'
import { writeSqliteAgentHistory } from '../../../src/agent/run/sqlite-history.js'
import { contextAccessScopeHash, createCanonicalSourceLoader } from '../../../src/agent/context/prepare.js'
import { ProviderStreamSanitizer, stripThinking } from '../../../src/agent/providers/index.js'
import type { CanonicalRunContext, CurrentUser, RunCheckpoint, RunEvent } from '../../../src/agent/models.js'

it('SQLite Agent Run 加密重读，阻止跨用户、过期租约与重复确认，失败时回滚事件和历史', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-run-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const identity = { ownerId, sessionId: String(session.id), runId: 'test-run' }
      const stranger = { ...identity, ownerId: randomUUID() }
      let now = 1000
      const clock = { now: () => now }
      const leases = createSqliteAgentRunLeasePort(runtime.db, { ...clock, ttlMs: 100_000 })
      const writeHistory = async () => { throw new Error('合成历史写入失败') }
      const store = createSqliteAgentRunStore(runtime.db, '合成密钥', { ...clock, writeHistory })
      const checkpoint = {
        identity, version: 0, sequence: 1, status: 'running', phase: 'prepare', context: null, text: '合成受限正文',
      } as RunCheckpoint<unknown>
      const started: RunEvent = { identity, id: 'e1', sequence: 1, round: 1, type: 'run_started', payload: {} }
      expect(await leases.acquire(stranger)).toBeNull()
      const first = (await leases.acquire(identity))!
      expect(first.fence).toBe(1)
      expect(await leases.acquire({ ...identity, runId: 'another' })).toBeNull()
      await store.create(checkpoint, first, [started])
      expect(await store.read(stranger)).toBeNull()
      expect(await store.read(identity)).toEqual(checkpoint)
      const row = await sql<{ payload: Buffer }>`SELECT payload FROM agent_run_checkpoints`.execute(runtime.db)
      expect(row.rows[0]!.payload.includes(Buffer.from(checkpoint.text))).toBe(false)

      now += 100_001
      const next = (await leases.acquire(identity))!
      expect(next.fence).toBe(2)
      const change = { identity, expectedVersion: 0, checkpoint: { ...checkpoint, version: 1 }, events: [], interactionReceipt: 'receipt-1', history: null }
      try {
        await expect(store.commit({ ...change, lease: first })).rejects.toMatchObject({ code: 'lease_lost' })
        await leases.release(identity, first)
        await leases.assert(identity, next)
        const token: RunEvent = { identity, id: 'e2', sequence: 2, round: 1, type: 'token', payload: { text: '合成增量' } }
        await expect(store.commit({
          ...change, lease: next, checkpoint: { ...change.checkpoint, sequence: 2 }, events: [token],
          history: { outcome: 'success', text: '', context: {} },
        })).rejects.toThrow('合成历史写入失败')
        expect((await store.read(identity))?.version).toBe(0)
        expect(await store.readEventsAfter(identity, 1)).toEqual([])
        await store.commit({ ...change, lease: next })
        await expect(store.commit({ ...change, checkpoint: { ...checkpoint, version: 2 }, expectedVersion: 1, lease: next }))
          .rejects.toMatchObject({ code: 'conflict' })
        await store.acknowledgeEvents(identity, ['e1'])
        expect(await store.pendingEvents(identity)).toEqual([])
      } finally {
        await leases.release(identity, first)
        await leases.release(identity, next)
      }
    } finally { await runtime.close() }

    const reopened = await openSqliteRuntime(path)
    try {
      const identity = { ownerId: reopened.ownerId, sessionId: '1', runId: 'test-run' }
      const store = createSqliteAgentRunStore(reopened.runtime.db, '合成密钥', { writeHistory: async () => {} })
      expect((await store.read(identity))?.version).toBe(1)
      expect(await store.readEventsAfter(identity, 0)).toMatchObject([{ id: 'e1', sequence: 1 }])
      expect(await store.readEventsAfter(identity, 1)).toEqual([])
    } finally { await reopened.runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('桌面事件订阅补读已提交事件，取消和启动失败可重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-run-control-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const identity = { ownerId, sessionId: '1', runId: 'control-test' }
    try {
      await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const store = createSqliteAgentRunStore(runtime.db, '合成密钥', { writeHistory: async () => {} })
      const controls = createSqliteAgentRunCoordination(runtime.db, store)
      const leases = createSqliteAgentRunLeasePort(runtime.db)
      const lease = (await leases.acquire(identity))!
      const checkpoint = {
        identity, version: 0, sequence: 1, status: 'running', phase: 'prepare', context: null,
      } as RunCheckpoint<unknown>
      try {
        const first: RunEvent = { identity, id: 'started', sequence: 1, round: 0, type: 'run_started', payload: {} }
        const last: RunEvent = { identity, id: 'done', sequence: 2, round: 0, type: 'final', payload: {} }
        await store.create(checkpoint, lease, [first])
        const stream = (await controls.events.open(identity, 1))[Symbol.asyncIterator]()
        try {
          const pending = stream.next()
          await store.commit({
            identity, expectedVersion: 0, lease, events: [last], interactionReceipt: null, history: null,
            checkpoint: { ...checkpoint, version: 1, sequence: 2, status: 'completed' },
          })
          await controls.events.notify(identity)
          expect(await pending).toEqual({ done: false, value: last })
          expect((await stream.next()).done).toBe(true)
        } finally { await stream.return?.() }
      } finally { await leases.release(identity, lease) }

      const cancelIdentity = { ...identity, runId: 'cancelled-before-start' }
      const unrelated = { ...identity, runId: 'other-run' }
      const received: string[] = []
      const stop = await controls.cancellation.subscribe(cancelIdentity, () => received.push('取消'))
      const stopOther = await controls.cancellation.subscribe(unrelated, () => received.push('其他运行'))
      await controls.cancellation.request(cancelIdentity)
      expect(received).toEqual([])
      await controls.cancellation.notify(cancelIdentity)
      expect(received).toEqual(['取消'])
      stop()
      stopOther()
      await controls.cancellation.notify(cancelIdentity)
      expect(received).toEqual(['取消'])
      await controls.failStart(cancelIdentity)
      expect(await leases.acquire(cancelIdentity)).toBeNull()
    } finally { await runtime.close() }

    const reopened = await openSqliteRuntime(path)
    try {
      const store = createSqliteAgentRunStore(reopened.runtime.db, '合成密钥', { writeHistory: async () => {} })
      const controls = createSqliteAgentRunCoordination(reopened.runtime.db, store)
      const cancelIdentity = { ...identity, runId: 'cancelled-before-start' }
      expect(await controls.cancellation.isRequested(cancelIdentity)).toBe(true)
      expect(await controls.cancellation.isRequested({ ...cancelIdentity, ownerId: randomUUID() })).toBe(false)
      expect(await controls.cancellation.isRequested(identity)).toBe(false)
      const replay = []
      for await (const event of await controls.events.open(cancelIdentity)) replay.push(event)
      expect(replay).toMatchObject([{ type: 'final', payload: { status: 'failed' } }])
    } finally { await reopened.runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('桌面追问沿用本会话前一条图片引用的槽位，其他会话和 owner 无法读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-references-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const db = runtime.db
      const session = await createDesktopAgentSession(db, ownerId, '合成会话')
      const other = await createDesktopAgentSession(db, ownerId, '另一合成会话')
      const admission = createSqliteAgentAdmission(db)
      const photo = { type: 'file', id: 'drop-synthetic-photo', label: '合成.png' }
      const references = [{ type: 'file', id: 'drop-synthetic-text', label: '合成.txt' }, photo]
      const first = await admission.prepare(ownerId, { session_id: session.id, message: '看图片', references })
      expect(await readDesktopTurnReferences(db, first.identity)).toEqual({ references, inherited: false })
      const store = createSqliteAgentRunStore(db, '合成密钥', { writeHistory: writeSqliteAgentHistory })
      await createSqliteAgentRunCoordination(db, store).failStart(first.identity)
      const followUp = await admission.prepare(ownerId, { session_id: session.id, message: '再试试' })
      const picked = await readDesktopTurnReferences(db, followUp.identity)
      expect(picked).toEqual({ references: [null, photo], inherited: true })
      const prompt = await resolveDesktopChatReferences(db, ownerId, picked.references, '再试试',
        async () => ({ name: photo.label, path: '/Users/synthetic/Desktop/合成.png', text: null }), picked.inherited)
      expect(prompt).toContain('最近明确引用的图片')
      expect(prompt).toContain('/Users/synthetic/Desktop/合成.png')
      expect(prompt).toContain(`【引用键】"${desktopFileReferenceKey(photo.id)}"`)
      expect(prompt).not.toContain('/references/1')
      const outside = await admission.prepare(ownerId, { session_id: other.id, message: '再试试' })
      for (const identity of [outside.identity, { ...followUp.identity, ownerId: randomUUID() }])
        expect(await readDesktopTurnReferences(db, identity)).toEqual({ references: [], inherited: false })
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('共享聊天服务通过 SQLite 原子登记，重复发送只重放同一运行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-agent-admission-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const failing = createSqliteAgentAdmission(runtime.db, { bindRun: async () => { throw new Error('合成绑定失败') } })
      const input = { session_id: session.id, message: '合成问题', client_message_id: 'synthetic-message' }
      await expect(failing.prepare(ownerId, input)).rejects.toThrow('合成绑定失败')
      const admission = createSqliteAgentAdmission(runtime.db)
      expect(await admission.active(ownerId, session.id)).toEqual({ identity: null, executionState: 'idle' })
      expect((await sql`SELECT id FROM conversation_messages WHERE session_id=${session.id}`.execute(runtime.db)).rows).toEqual([])
      await expect(admission.prepare(randomUUID(), input)).rejects.toMatchObject({ code: 'not_found' })

      await sql`UPDATE conversation_sessions SET session_context=${JSON.stringify({
        goal_text: '合成目标', goal_mode: true, goal_status: 'active',
      })} WHERE id=${session.id}`.execute(runtime.db)
      const source = createSqliteAgentSessionSource(runtime.db)
      const committed = [] as Array<Promise<Awaited<ReturnType<typeof readDesktopAgentMessages>>>>
      const { store, leases, createChat } = createSqliteAgentPersistence<CanonicalRunContext>({
        db: runtime.db,
        secret: '合成密钥',
        admission: { onCommitted: identity => {
          committed.push(readDesktopAgentMessages(runtime.db, identity.ownerId, Number(identity.sessionId)))
        } },
        history: { writeHistory: writeSqliteAgentHistory, applyPreparedContext: applySqliteAgentSnapshot },
        projection: { interaction: async () => { throw new Error('测试不触发交互') } },
      })
      let starts = 0
      let originalUser: CurrentUser | undefined
      const service = createChat({
        async *start(identity) {
          expect(await Promise.all(committed)).toEqual([[expect.objectContaining({ role: 'user', text: input.message })]])
          starts++
          const { currentUser } = await source.currentTurn(identity)
          expect(currentUser?.rawText).toBe(input.message)
          originalUser = currentUser
          await expect(source.currentTurn({ ...identity, ownerId: randomUUID() })).rejects.toThrow('用户消息不存在')
          const snapshot = (await source.readSnapshot(identity))!
          const history = await source.historyReader.read(identity)
          expect(history.rows.map(row => row.id)).toEqual([currentUser!.persistedMessageId])
          await expect(source.historyReader.read({ ...identity, ownerId: randomUUID() })).rejects.toThrow('Agent 会话不存在')
          const area = new MessageArea({ digest: value => createHash('sha256').update(stableJson(value)).digest('hex'), nextId: randomUUID })
          area.append({ role: 'user', content: '合成召回' }, { source: 'rag', persistencePolicy: 'commit_on_success' })
          area.append(currentUser!.message, {
            source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: currentUser!.persistedMessageId,
          })
          area.append({ role: 'assistant', content: '合成工具轮次' }, { source: 'tool_round', persistencePolicy: 'commit_on_success' })
          const context = {
            identity, prepared: { area: area.snapshot() }, historyBaseline: history.baselineIdentity,
            sourceEffects: { sessionSnapshot: {
              expectedEpoch: snapshot.contextEpoch, expectedSnapshotHash: snapshot.snapshotHash,
              state: { ...snapshot, contextEpoch: snapshot.contextEpoch + 1, snapshotHash: 'synthetic-snapshot', context: { ...snapshot.context, timezone: 'UTC' } },
            } },
          } as CanonicalRunContext
          const lease = (await leases.acquire(identity))!
          const started: RunEvent = { identity, id: 'started', sequence: 1, round: 0, type: 'run_started', payload: {} }
          const done: RunEvent = { identity, id: 'done', sequence: 2, round: 0, type: 'final', payload: { status: 'completed' } }
          const checkpoint = { identity, version: 0, sequence: 1, status: 'running', phase: 'prepare', context: null } as RunCheckpoint<CanonicalRunContext>
          try {
            await store.create(checkpoint, lease, [started])
            yield started
            const stale = { ...context, sourceEffects: { sessionSnapshot: {
              ...context.sourceEffects!.sessionSnapshot, expectedEpoch: snapshot.contextEpoch + 10,
            } } } as CanonicalRunContext
            await expect(store.commit({
              identity, expectedVersion: 0, checkpoint: { ...checkpoint, version: 1, context: stale },
              lease, events: [], history: null, interactionReceipt: null,
            })).rejects.toThrow('会话快照已变化')
            expect(await source.readSnapshot(identity)).toEqual(snapshot)
            await sql`UPDATE conversation_sessions SET session_context=${JSON.stringify({ goal_mode: false })}
              WHERE id=${session.id}`.execute(runtime.db)
            await store.commit({
              identity, expectedVersion: 0, checkpoint: { ...checkpoint, version: 1, sequence: 2, status: 'completed', context, files: [], displayTimeline: [] },
              lease, events: [done], history: { outcome: 'success', context, text: '合成回复' }, interactionReceipt: null,
            })
            const saved = await source.readSnapshot(identity)
            expect(saved).toMatchObject({ snapshotHash: 'synthetic-snapshot', context: { timezone: 'UTC', goal_mode: false } })
            expect(saved?.context).not.toHaveProperty('goal_text')
            expect(saved?.context).not.toHaveProperty('goal_status')
            yield done
          } finally { await leases.release(identity, lease) }
        },
        async cancel() { return false },
      })
      const first = await collect(await service.start(ownerId, input, undefined))
      const second = await collect(await service.start(ownerId, input, undefined))
      expect(first.map(event => event.type)).toEqual(['session_id', 'done'])
      expect(second).toEqual(first)
      expect(starts).toBe(1)
      expect(await admission.active(ownerId, session.id)).toEqual({ identity: null, executionState: 'idle' })
      const runId = String(first[0]?.run_id)
      const resumed = await service.resume(ownerId, session.id, undefined, runId)
      expect(resumed && await collect(resumed)).toEqual(first.slice(1))
      expect(await service.resume(randomUUID(), session.id, undefined, runId)).toBeNull()
      const rows = await sql<{ content: string; history_anchor_seq: number | null }>`
        SELECT content,history_anchor_seq FROM conversation_messages WHERE session_id=${session.id} ORDER BY conversation_seq`.execute(runtime.db)
      expect(rows.rows).toEqual([
        { content: '合成问题', history_anchor_seq: null },
        { content: '合成召回', history_anchor_seq: 1 },
        { content: '合成工具轮次', history_anchor_seq: null },
        { content: '合成回复', history_anchor_seq: null },
      ])
      const historyIdentity = { ownerId, sessionId: String(session.id) }
      expect(originalUser?.messageTimestamp).toBeTruthy()
      const currentUser = { ...originalUser, message: { role: 'user' as const, content: input.message } }
      const prepared = await prepareContext({ ...historyIdentity, history: [], fixedPrefix: [], currentUser, userTimezone: 'UTC' }, {
        digest: value => createHash('sha256').update(stableJson(value)).digest('hex'), nextId: randomUUID,
        buildRag: async () => ({ tail: [] }), formatMessageTime: formatAgentHistoryMessageTime,
      })
      const originalUserPrompt = contentText(prepared.area.messages[0]!.content)
      expect(originalUserPrompt).toMatch(/^【消息时间】/)
      const persisted = await source.historyReader.read(historyIdentity)
      const ordered = selectSessionHistory(historyIdentity, persisted.rows, persisted.baselineSeq).rows
      expect(ordered.slice(0, 2).map(row => row.content)).toEqual(['合成召回', '合成问题'])
      const restored = restoreHistoryForRequest(ordered[1]!, {
        userTimezone: 'UTC', formatMessageTime: formatAgentHistoryMessageTime,
      })
      expect(contentText(restored!.content)).toBe(originalUserPrompt)
      expect(await readDesktopAgentMessages(runtime.db, ownerId, session.id)).toMatchObject([
        { role: 'user', text: '合成问题', runId },
        { role: 'assistant', text: '合成回复', runId },
      ])
      const rebuildConversation = createSqlRagRebuildWorker(runtime.db, 'sqlite', {
        conversation: createConversationRagSource(runtime.db, 'sqlite'),
      })
      expect(await rebuildConversation()).toBe('ready')
      const indexed = await sql<{ content: string }>`SELECT content FROM knowledge_index_entries
        WHERE source_type='conversation' AND deleted_at IS NULL`.execute(runtime.db)
      expect(indexed.rows).toEqual(expect.arrayContaining([
        { content: expect.stringContaining('合成问题') }, { content: expect.stringContaining('合成回复') },
      ]))
      await expect(admission.prepare(ownerId, { ...input, message: '标识相同但正文不同' }))
        .rejects.toMatchObject({ code: 'conflict' })
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of source) result.push(value)
  return result
}

it('SQLite 共享 Agent 实际执行模型请求，下一轮读取已落库的上下文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-agent-runtime-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
      const selection = { modelIdentity: 'synthetic', contextWindow: 256_000, locale: 'zh-CN', groupChat: false,
        workspaceBinding: null, contextPolicy: { loadOwnerContext: false, memoryEnabled: false } }
      const source = createCanonicalSourceLoader({
        ...createSqliteAgentSessionSource(runtime.db),
        digest, nextId: randomUUID, now: Date.now,
        select: async () => selection,
        currentRevision: async () => 0,
        data: { loadTimezone: async () => 'UTC', loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [],
          loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}),
          loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
        builder: {
          buildSnapshot: () => ({ systemPrompt: '合成系统', snapshotContext: '', sessionInfo: {}, userTimezone: 'UTC' }),
          buildRequest: () => ({ systemPrompt: '合成系统', systemInMessages: false, fixedPrefix: [] }),
        },
      })
      const requests: string[] = []
      const [secret, concurrent] = await Promise.all([
        loadSqliteAgentRunSecret(runtime.db, path), loadSqliteAgentRunSecret(runtime.db, path),
      ])
      expect(concurrent).toBe(secret)
      const keyPath = path + '.agent-run-key'
      if (process.platform !== 'win32') expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
      const agent = createSqliteAgentRuntime({
        db: runtime.db, secret, admission: {},
        projection: { async interaction() { throw new Error('测试不触发交互') } },
        context: {
          digest, nextId: randomUUID,
          async load(identity, signal) {
            const loaded = await source.load(identity, signal)
            return { ...loaded, capabilities: { toolNames: [], tools: [] } }
          },
          preparation: { buildRag: async () => ({ tail: [] }) },
          prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
          references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
          compaction: { async summarize() { throw new Error('测试不触发压缩') } },
          finalization: { complete: async () => {} }, currentRequest: () => null,
          async stageContinuation() { throw new Error('测试不触发原生续接') },
          releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
        },
        executor: {
          async authorize() { throw new Error('测试不执行进程') },
          executor: { async execute() { throw new Error('测试不执行进程') } },
        },
        runtime: {
          clock: { now: () => new Date().toISOString() },
          tools: { async dispatch() { throw new Error('测试不调用工具') }, reconcile: async () => ({ kind: 'unknown' }) },
          interactions: { async activate() { throw new Error('测试不触发交互') } },
          sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
          presentError: () => ({ code: 'failed', text: '合成模型错误' }), presentToolResult: async value => value,
          publish: async () => {}, diagnose: () => {},
        },
        provider: {
          resolve: async identity => ({ modelIdentity: selection.modelIdentity, accessScopeHash: contextAccessScopeHash(identity, selection, digest),
            config: { provider: 'openai', model: 'synthetic', api_key: 'synthetic-key' }, systemPrompt: '合成系统' }),
          transport: { async request(request) {
            requests.push(JSON.stringify(request.body))
            const body = (async function* () {
              yield Buffer.from('data: {"choices":[{"delta":{"content":"合成模型回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            })()
            return { status: 200, headers: {}, body, cancel: async () => {} }
          } },
        },
      })
      try {
        const first = await collect(await agent.service.start(ownerId, { session_id: session.id, message: '第一条合成提问' }, undefined))
        expect(first.at(-1)).toMatchObject({ type: 'done' })
        expect(first.some(event => event.type === 'error')).toBe(false)
        const second = await collect(await agent.service.start(ownerId, { session_id: session.id, message: '第二条合成提问' }, undefined))
        expect(second.at(-1)).toMatchObject({ type: 'done' })
        expect(second.some(event => event.type === 'error')).toBe(false)
        expect(requests).toHaveLength(2)
        expect(requests.at(-1)).toContain('第一条合成提问')
        expect(requests.at(-1)).toContain('合成模型回复')
        expect(requests.at(-1)).toContain('第二条合成提问')
        const replay = await agent.service.resume(ownerId, session.id, undefined, String(first[0]?.run_id))
        expect(replay && await collect(replay)).toEqual(first.slice(1))
        const readEvents = createDesktopAgentEventReader(runtime.db, path, ownerId)
        const runId = String(first[0]?.run_id)
        const page = await readEvents(session.id, runId, 0)
        expect(page).toMatchObject({ runId, events: first.slice(1), status: 'completed', hasMore: false })
        expect(await readEvents(session.id, runId, page.cursor)).toMatchObject({ events: [], cursor: page.cursor, hasMore: false })
        await expect(readEvents(session.id, 'unknown-run', 0)).rejects.toMatchObject({ code: 'not_found' })
        const admission = createSqliteAgentAdmission(runtime.db)
        const next = await admission.prepare(ownerId, { session_id: session.id, message: '待取消的合成消息' })
        const store = createSqliteAgentRunStore(runtime.db, secret, { async writeHistory() {} })
        const { cancellation } = createSqliteAgentRunCoordination(runtime.db, store)
        expect(await admission.requestCancel(ownerId, session.id, runId)).toEqual({ ok: true, outcome: 'already_completed' })
        expect(await cancellation.isRequested(next.identity)).toBe(false)
        await expect(admission.requestCancel(randomUUID(), session.id, next.identity.runId)).rejects.toMatchObject({ code: 'not_found' })
        const leases = createSqliteAgentRunLeasePort(runtime.db)
        const lease = (await leases.acquire(next.identity))!
        const memory = createSqliteRememberMemory(runtime.db)
        const input = { target: 'profile' as const, text: '合成用户偏好', remove: [] }
        const call = { ...next.identity, roundId: 'round-1', toolCallId: 'synthetic-memory' }
        const signal = new AbortController().signal
        try {
          const saved = await memory.mutate(call, input, signal, rows => applyRememberEdit(rows, input, 0, () => 'synthetic'))
          expect(saved).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { added: 1 } })
          expect(await memory.mutate(call, input, signal, () => { throw new Error('重放不得再次编辑') })).toEqual(saved)
          expect(await memory.reconcile({ ...call, ownerId: randomUUID() }, input)).toEqual({ kind: 'unknown' })
          expect(await memory.mutate({ ...call, toolCallId: 'remove' }, { ...input, remove: [input.text] }, signal,
            () => { throw new Error('未确认删除不得编辑') })).toMatchObject({ successful: false, mutated: false })
        } finally { await leases.release(next.identity, lease) }
        expect(await admission.requestCancel(ownerId, session.id, next.identity.runId)).toEqual({ ok: true, outcome: 'requested' })
        expect(await cancellation.isRequested(next.identity)).toBe(true)
        expect(await loadSqliteAgentRunSecret(runtime.db, path)).toBe(secret)
        await rename(keyPath, keyPath + '.test-backup')
        try {
          await expect(loadSqliteAgentRunSecret(runtime.db, path)).rejects.toThrow('本机 Agent 运行密钥缺失')
        } finally { await rename(keyPath + '.test-backup', keyPath) }
      } finally { await agent.close() }
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('独占重启结算遗留运行，保留事件并允许会话再次发送', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sqlite-agent-recovery-'))
  const path = join(directory, 'core.db')
  try {
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path, { exclusive: true })
    try {
      const create = () => runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成会话'))
      const session = await create(), queued = await create(), compacting = await create()
      const admission = createSqliteAgentAdmission(runtime.db)
      const input = { session_id: session.id, message: '合成旧消息' }
      const accepted = await admission.prepare(ownerId, input)
      const { identity } = accepted
      const early = await admission.prepare(ownerId, { ...input, session_id: queued.id })
      const owner = ownerId.replaceAll('-', '')
      await sql`UPDATE conversation_sessions SET execution_state='baseline_updating',baseline_message_hash='已保存摘要指纹'
        WHERE user_id=${owner} AND id=${compacting.id}`.execute(runtime.db)
      for (const job of [accepted, early]) {
        const isExhausted = job.identity.runId === early.identity.runId
        await sql`INSERT INTO desktop_agent_reflection_jobs
          (user_id,session_id,run_id,user_message_id,model_identity,assistant_text,status,attempts,claimed_at_ms,created_at_ms)
          VALUES(${owner},${Number(job.identity.sessionId)},${job.identity.runId},${job.userMessageId},
            'synthetic-model','合成反思','processing',${isExhausted ? 3 : 1},${Date.now()},${Date.now()})`.execute(runtime.db)
      }
      const secret = await loadSqliteAgentRunSecret(runtime.db, path)
      const store = createSqliteAgentRunStore(runtime.db, secret, { async writeHistory() {} })
      const leases = createSqliteAgentRunLeasePort(runtime.db)
      const lease = (await leases.acquire(identity))!
      const started: RunEvent = { id: 'started', identity, sequence: 1, round: 1, type: 'run_started', payload: {} }
      try {
        const createdAt = '2026-01-01T00:00:00.000Z'
        const tool = (id: string, status: string, sequence: number) => ({
          eventId: id, kind: 'tool', runId: identity.runId, roundId: `${identity.runId}:1`,
          sequence, anchorMessageId: String(accepted.userMessageId), timelineOrder: null,
          createdAt, updatedAt: createdAt, toolCallId: id, toolStatus: status,
        })
        const displayTimeline = [
          tool('completed', 'success', 1), tool('search-a', 'running', 2),
          tool('search-b', 'running', 3), tool('queued', 'queued', 4), tool('waiting', 'waiting', 5),
        ]
        await store.create({
          identity, version: 0, sequence: 1, status: 'running', phase: 'tools', round: 1, context: null, displayTimeline,
          inflightCalls: ['search-a', 'search-b', 'queued'].map(id => ({ id, name: 'deep_research', input: { query: id } })),
        } as unknown as RunCheckpoint<unknown>, lease, [started])
        const requested: string[] = []
        const reconcile: NonNullable<Parameters<typeof settleExclusiveSqliteAgentRuns>[3]> = async (call, source) => {
          expect(source).toEqual({ ...identity, roundId: `${identity.runId}:1` })
          requested.push(call.id)
          if (call.id === 'search-a')
            return { kind: 'completed', successful: true, mutated: false, value: { answer: '合成搜索结果' } }
          return { kind: 'unknown' }
        }
        await settleExclusiveSqliteAgentRuns(runtime.db, path, ownerId, reconcile)
        await settleExclusiveSqliteAgentRuns(runtime.db, path, ownerId, reconcile)
        expect(requested).toEqual(['search-a', 'search-b'])
        const recovered = await store.read(identity)
        expect(recovered).toMatchObject({ status: 'unknown', remoteStatusUnknown: true, sequence: 2 })
        expect(recovered?.displayTimeline.map(item => [item.eventId, item.toolStatus])).toEqual([
          ['completed', 'success'], ['search-a', 'success'], ['search-b', 'unknown'],
          ['queued', 'stopped'], ['waiting', 'stopped'],
        ])
        expect(recovered?.displayTimeline.find(item => item.toolCallId === 'search-a')?.toolResult)
          .toEqual({ answer: '合成搜索结果' })
        expect(await store.readEventsAfter(identity, 0)).toEqual([
          started, expect.objectContaining({ type: 'final', sequence: 2, payload: expect.objectContaining({
            status: 'unknown', sealedTools: recovered?.displayTimeline.slice(1),
          }) }),
        ])
        const state = createSqliteAgentRunCoordination(runtime.db, store).readState
        expect(await state(early.identity)).toMatchObject({ status: 'startup_failed' })
        const compacted = await sql`SELECT execution_state,baseline_message_hash FROM conversation_sessions
          WHERE user_id=${owner} AND id=${compacting.id}`.execute(runtime.db)
        expect(compacted.rows).toEqual([{ execution_state: 'idle', baseline_message_hash: '已保存摘要指纹' }])
        await expect(admission.prepare(ownerId, { ...input, session_id: compacting.id })).resolves.toHaveProperty('userMessageId')
        const reflection = await sql`SELECT status, attempts, claimed_at_ms, last_error
          FROM desktop_agent_reflection_jobs WHERE user_id=${owner} ORDER BY attempts`.execute(runtime.db)
        expect(reflection.rows).toEqual([
          { status: 'queued', attempts: 1, claimed_at_ms: null, last_error: 'reflection_interrupted' },
          { status: 'failed', attempts: 3, claimed_at_ms: null, last_error: 'reflection_interrupted' },
        ])
        const next = await admission.prepare(ownerId, { ...input, message: '合成新消息' })
        expect(next.identity.runId).not.toBe(identity.runId)
      } finally { await leases.release(identity, lease) }
    } finally { await runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
