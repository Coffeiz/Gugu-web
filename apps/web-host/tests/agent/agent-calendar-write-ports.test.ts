import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentRuntime, createCanonicalSourceLoader, stableJson } from '@gugu/core/agent'
import type { AgentRunnerPorts, CanonicalContextPorts, CanonicalRunContext, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { createConfirmationGate } from '@gugu/core/tools'
import type { ConfirmationBinding, ConfirmationIntent, ConfirmationTargetSnapshot } from '@gugu/core/tools'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { agentContextAccessScope } from '../../src/domains/agent-config/access-scope.js'
import { bindProviderSelection } from '../../src/domains/agent-config/provider-resolver.js'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createWebAgentCalendarWritePorts } from '../../src/domains/agent-sessions/tools/agent-calendar-write-ports.js'
import { createWebAgentCanvasWritePorts } from '../../src/domains/agent-sessions/tools/agent-canvas-write-ports.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type RuntimePorts = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>

test('Web 日历组合经注册器保存提醒并更新事件，撤权后拒绝写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-calendar-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '7', runId: 'run-a' }
    const lease = { identity, input: { v: 2, source: 'web' }, token: 'synthetic', fence: 1 } as never
    let releases = 0, allowed = true
    const pool = { async connect() { return { async query() { return { rowCount: 1 } }, release() { releases++ } } } } as never
    const publications: unknown[] = []
    const ports = createWebAgentCalendarWritePorts({ core: runtime, pool, lease,
      delivery: { async resolveDelivery(_client, owner, input) {
        assert.equal(owner, identity.ownerId)
        assert.deepEqual(input.channels, ['qq'])
        return { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic' } }
      } },
      async publishCreate(event) { publications.push(event) }, async publishUpdate(event) { publications.push(event) },
    })
    const registry = createAgentToolRegistry({ core: runtime, ...ports,
      time: { now: () => new Date('2099-11-25T12:00:00Z'), timezone: async () => 'UTC' },
      authorize: async (candidate, name) => allowed && candidate.ownerId === identity.ownerId
        && ['create_event', 'update_event', 'list_events', 'get_upcoming'].includes(name) })
    const scope = { identity, roundId: 'round-a', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不执行 Shell') } }
    const created = await registry.tools.dispatch({ id: 'create', name: 'create_event', input: {
      title: '合成活动', date: '2099-12-01', time: '10:00', all_day: false, reminders: [{ lead_minutes: 30, channels: ['qq'] }],
    } }, scope)
    assert.equal(created.kind, 'completed')
    if (created.kind !== 'completed') throw new Error('创建未完成')
    assert.equal(created.successful, true)
    const eventId = (created.value as { event_id: number }).event_id
    const updated = await registry.tools.dispatch({ id: 'update', name: 'update_event', input: { event_id: eventId, title: '更新活动' } }, scope)
    assert.equal(updated.kind === 'completed' && updated.successful, true)
    const stored = await runtime.db.selectFrom('calendar_events').select('title').where('id', '=', eventId).executeTakeFirst()
    assert.equal(stored?.title, '更新活动')
    const reminder = await runtime.db.selectFrom('scheduled_tasks').select(['channels', 'delivery_targets']).where('event_id', '=', eventId).executeTakeFirst()
    assert.equal(reminder?.channels, 'qq')
    assert.deepEqual(JSON.parse(String(reminder?.delivery_targets)), { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic' } })
    assert.ok(publications.length >= 2)
    assert.equal(releases, 1)
    await runtime.db.insertInto('calendar_events').values({ id: 99002, user_id: '22222222222242228222222222222222', title: '他人日程', date: '2099-12-01', type: 'event', version: 1,
      created_at: '2099-01-01 00:00:00', deleted_at: null }).execute()
    const listed = await registry.tools.dispatch({ id: 'list', name: 'list_events', input: { from: '2099-12-01', to: '2099-12-01' } }, scope)
    assert.equal(listed.kind === 'completed' && listed.successful, true)
    if (listed.kind !== 'completed') throw new Error('日历读取未完成')
    const listedEvents = listed.value as { id: number; title: string; reminders: unknown[] }[]
    assert.deepEqual(listedEvents.map(event => event.title), ['更新活动'])
    assert.equal(listedEvents[0]?.id, eventId)
    assert.equal(listedEvents[0]?.reminders.length, 1)
    const upcoming = await registry.tools.dispatch({ id: 'upcoming', name: 'get_upcoming', input: { days: 7 } }, scope)
    assert.equal(upcoming.kind === 'completed' && upcoming.successful, true)
    if (upcoming.kind !== 'completed') throw new Error('近期安排读取未完成')
    assert.deepEqual((upcoming.value as { items: { title: string }[] }).items.map(item => item.title), ['更新活动'])
    allowed = false
    const denied = await registry.tools.dispatch({ id: 'denied', name: 'update_event', input: { event_id: eventId, title: '不应写入' } }, scope)
    assert.equal(denied.kind === 'completed' && denied.successful, false)
    assert.equal((await runtime.db.selectFrom('calendar_events').select('title').where('id', '=', eventId).executeTakeFirst())?.title, '更新活动')
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('实际 Core Agent Runtime 续轮日历与画布写入并恢复五项危险操作确认', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-calendar-run-'))
  let runtimeDb: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  let instance: ReturnType<typeof createAgentRuntime> | undefined
  let providerBinding: Awaited<ReturnType<typeof bindProviderSelection>> | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtimeDb = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '70', runId: randomUUID() }
    const lease = { identity, input: { v: 2, source: 'web' }, token: 'synthetic-lease', fence: 1 } as never
    let pendingConfirmationId: string | null = null
    const makeConfirmationHarness = (action: string) => {
      let intent: ConfirmationIntent | null = null
      let targets: ConfirmationTargetSnapshot | null = null
      let receipt: unknown = null
      const gate = createConfirmationGate({
        now: () => Date.now(),
        async authorize(binding, purpose, candidateAction) {
          return binding.ownerId === identity.ownerId && purpose === 'action' && candidateAction === action ? 'synthetic-auth-epoch' : null
        },
        async prepare(binding: ConfirmationBinding, snapshot: ConfirmationTargetSnapshot) {
          targets = structuredClone(snapshot)
          intent = {
            schemaVersion: 2, binding, intentId: randomUUID(), interactionId: `${action}-confirmation`,
            operationId: randomUUID(), purpose: 'action', action,
            targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest,
            authorizationEpoch: 'synthetic-auth-epoch', expiresAt: Date.now() + 60_000,
          }
          return intent
        },
        async load(_binding, reference) {
          return intent?.interactionId === reference.interactionId && receipt ? { intent, receipt } : null
        },
        async inspect(reference) {
          return reference.intentId === intent?.intentId && targets ? targets : null
        },
      }, { purpose: 'action', action })
      const port: NonNullable<Parameters<typeof createWebAgentCanvasWritePorts>[0]['batchConfirmation']> = {
        gate,
        async claim(_tx, reference) {
          assert.equal(reference.action, action)
          assert.equal(reference.targetsDigest, targets?.targetsDigest)
          return true
        },
      }
      return {
        gate,
        get intent() { return intent },
        approve(receiptId: string) {
          if (!intent) throw new Error('确认意图未准备')
          receipt = {
            schemaVersion: 2, intentId: intent.intentId, interactionId: intent.interactionId, receiptId,
            binding: intent.binding, purpose: intent.purpose, action: intent.action, status: 'approved', expiresAt: intent.expiresAt,
          }
          return receiptId
        },
        port,
      }
    }
    const deleteConfirmation = makeConfirmationHarness('delete_event')
    const canvasConfirmation = makeConfirmationHarness('canvas_batch')
    const deleteNoteConfirmation = makeConfirmationHarness('canvas_delete_note')
    const disconnectConfirmation = makeConfirmationHarness('canvas_disconnect')
    const deleteCanvasConfirmation = makeConfirmationHarness('canvas_delete')
    const timestamp = '2099-01-01 00:00:00.000000'
    const ownerKey = identity.ownerId.replaceAll('-', '')
    await sql`INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at)
      VALUES(1,${ownerKey},'Runtime 画布','{}',${timestamp},${timestamp}),
      (2,${ownerKey},'Runtime 待删画布','{}',${timestamp},${timestamp})`.execute(runtimeDb.db)
    await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at)
      VALUES(1,${ownerKey},'canvas_note','Runtime 便签','# Runtime 便签','Runtime 便签','user',1,${timestamp},${timestamp},${timestamp}),
      (2,${ownerKey},'canvas_note','独立待删便签','# 独立待删便签','独立待删便签','user',1,${timestamp},${timestamp},${timestamp}),
      (3,${ownerKey},'note','关系来源','# 关系来源','关系来源','user',1,${timestamp},${timestamp},${timestamp}),
      (4,${ownerKey},'note','关系目标','# 关系目标','关系目标','user',1,${timestamp},${timestamp},${timestamp}),
      (5,${ownerKey},'canvas_note','级联便签','# 级联便签','级联便签','user',1,${timestamp},${timestamp},${timestamp})`.execute(runtimeDb.db)
    await sql`INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at)
      VALUES(1,${ownerKey},1,1,0,0,1,0,'{}',${timestamp},${timestamp}),
      (2,${ownerKey},1,2,1,1,2,0,'{}',${timestamp},${timestamp}),
      (3,${ownerKey},1,3,2,2,3,0,'{}',${timestamp},${timestamp}),
      (4,${ownerKey},1,4,3,3,4,0,'{}',${timestamp},${timestamp}),
      (5,${ownerKey},2,5,0,0,1,0,'{}',${timestamp},${timestamp})`.execute(runtimeDb.db)
    await sql`INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,note,created_at,updated_at,deleted_at)
      VALUES(1,${ownerKey},1,3,4,'related','','user','confirmed',NULL,${timestamp},${timestamp},NULL)`.execute(runtimeDb.db)
    const pool = { async connect() { return {
      async query(_sql: string, params: unknown[]) {
        assert.deepEqual(params, [identity.ownerId, identity.sessionId, identity.runId, 'synthetic-lease', 1])
        return { rowCount: 1 }
      },
      release() {},
    } } } as never
    const registry = createAgentToolRegistry({ core: runtimeDb,
      ...createWebAgentCalendarWritePorts({
      core: runtimeDb, pool, lease, deleteConfirmation: deleteConfirmation.port,
      delivery: { async resolveDelivery(_client, owner, input) {
        assert.equal(owner, identity.ownerId)
        assert.deepEqual(input.channels, ['qq'])
        return { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic-target' } }
      } },
      async publishCreate() {}, async publishUpdate() {}, async publishDelete() {},
    }),
      ...createWebAgentCanvasWritePorts({ core: runtimeDb, batchConfirmation: canvasConfirmation.port,
        deleteNoteConfirmation: deleteNoteConfirmation.port, disconnectConfirmation: disconnectConfirmation.port,
        deleteConfirmation: deleteCanvasConfirmation.port,
        async publishBatchAndNotes() {}, async publishDisconnect() {}, async publishDelete() {} }),
      authorize: async (candidate, name) => candidate.ownerId === identity.ownerId
        && ['create_event', 'update_event', 'delete_event', 'canvas_batch', 'canvas_delete_note', 'canvas_disconnect', 'canvas_delete'].includes(name) })
    const policy = { groupChat: false, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
    const access = agentContextAccessScope('synthetic-calendar-runtime-secret', identity, policy,
      { permissions: '1', model: '1', credentials: '1' }, digest, 'owner')
    providerBinding = await bindProviderSelection(identity, {
      selectPlatformModel: async () => ({ config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统',
        byokEnabled: false, localDeployment: false, accessScopeHash: access.accessScopeHash }),
      readActiveCredential: async () => null,
      decryptCredential: () => { throw new Error('合成 Runtime 不应读取凭据') },
      defaultBaseUrl: () => '',
    }, new AbortController().signal)
    const source = createCanonicalSourceLoader({
      digest, nextId: randomUUID, now: () => 0,
      readSnapshot: async () => ({ ...identity, contextEpoch: 0, context: null, snapshotHash: null,
        sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }),
      select: async () => ({ ...policy, modelIdentity: providerBinding!.modelIdentity, contextWindow: 10000,
        locale: 'zh-CN', workspaceBinding: null, contextScopeKey: access.contextScopeKey }),
      currentRevision: async () => 0,
      historyReader: { read: async () => ({ baselineSeq: 0, rows: [] }) },
      currentTurn: async () => ({ currentUser: { persistedMessageId: '1', message: { role: 'user', content: '创建并更新日历活动，再删除合成画布便签。' } } }),
      data: { loadTimezone: async () => 'UTC', loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [],
        loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}),
        loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
      builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '合成快照', sessionInfo: {}, userTimezone: 'UTC' }),
        buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) },
    })
    const context: CanonicalContextPorts = {
      digest, nextId: randomUUID,
      load: async (id, signal) => {
        const tools = await registry.capabilities(id)
        return { ...await source.load(id, signal), capabilities: { toolNames: tools.map(tool => tool.name), tools } }
      },
      preparation: { buildRag: async () => ({ tail: [] }) },
      prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
      references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
      compaction: { summarize: async () => { throw new Error('该回归不应压缩') } },
      finalization: { complete: async () => {} }, currentRequest: () => null,
      stageContinuation: async () => { throw new Error('该回归不应续接 Provider 私有状态') },
      releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
    }
    let checkpoint: RunCheckpoint<CanonicalRunContext> | null = null
    const outbox: RunEvent[] = [], requests: Array<Record<string, unknown>> = [], toolResults = new Map<string, unknown>()
    const runPorts: RuntimePorts = {
      clock: { now: () => '2026-01-01T20:00:00Z' },
      store: {
        read: async () => checkpoint,
        create: async (value, _lease, events) => { checkpoint = structuredClone(value); outbox.push(...events) },
        commit: async change => {
          assert.equal(checkpoint?.version, change.expectedVersion)
          checkpoint = structuredClone(change.checkpoint)
          outbox.push(...change.events)
        },
        pendingEvents: async () => outbox,
        acknowledgeEvents: async (_identity, ids) => {
          const acknowledged = new Set(ids)
          for (let index = outbox.length - 1; index >= 0; index--) { if (acknowledged.has(outbox[index]!.id)) outbox.splice(index, 1) }
        },
      },
      leases: { acquire: async () => ({ token: 'synthetic-run-lease', fence: 1 }), assert: async () => {}, release: async () => {} },
      cancellation: { isRequested: async () => false, request: async () => {}, notify: async () => {}, subscribe: async () => () => {} },
      tools: registry.tools,
      interactions: { activate: async (_id, request) => { pendingConfirmationId = request.id; return request } },
      sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
      presentError: () => ({ code: 'failed', text: '合成 Agent 运行失败' }), presentToolResult: async value => value,
      publish: async () => {}, diagnose: () => {},
    }
    instance = createAgentRuntime({ context, runtime: runPorts,
      executor: { authorize: async () => { throw new Error('日历工具不得调用 Shell 授权') }, executor: { execute: async () => { throw new Error('日历工具不得调用 Shell') } } },
      provider: { resolve: providerBinding.resolve, transport: { request: async request => {
        const body = request.body as Record<string, unknown>
        requests.push(body)
        if (requests.length === 1) {
          const definitions = body.tools as Array<{ function: { name: string } }>
          assert.deepEqual(definitions.map(tool => tool.function.name).sort(), ['canvas_batch', 'canvas_delete', 'canvas_delete_note', 'canvas_disconnect', 'create_event', 'delete_event', 'update_event'])
          return response({ tool_calls: [{ index: 0, id: 'create-event', type: 'function', function: { name: 'create_event',
            arguments: JSON.stringify({ title: 'Runtime 活动', date: '2099-12-02', time: '10:00', all_day: false, reminders: [{ lead_minutes: 30, channels: ['qq'] }] }) } }] }, 'tool_calls')
        }
        const messages = body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>
        for (const message of messages.filter(value => value.role === 'tool')) {
          let content = message.content
          if (Array.isArray(content)) content = (content[0] as { text?: unknown }).text
          assert.equal(typeof content, 'string')
          toolResults.set(message.tool_call_id!, JSON.parse(content as string))
        }
        if (requests.length === 2) {
          const created = toolResults.get('create-event') as { success: boolean; event_id: number; reminders: unknown[] }
          assert.equal(created.success, true)
          assert.ok(created.event_id > 0)
          assert.equal(created.reminders.length, 1)
          return response({ tool_calls: [{ index: 0, id: 'update-event', type: 'function', function: { name: 'update_event',
            arguments: JSON.stringify({ event_id: created.event_id, title: 'Runtime 活动已更新' }) } }] }, 'tool_calls')
        }
        if (requests.length === 3) {
          const updated = toolResults.get('update-event') as { success: boolean; event_id: number }
          assert.equal(updated.success, true)
          assert.equal(updated.event_id, (toolResults.get('create-event') as { event_id: number }).event_id)
          return response({ tool_calls: [{ index: 0, id: 'delete-event', type: 'function', function: { name: 'delete_event',
            arguments: JSON.stringify({ event_id: updated.event_id }) } }] }, 'tool_calls')
        }
        if (requests.length === 4) {
          const deleted = toolResults.get('delete-event') as { success: boolean; deleted_event_id: number }
          assert.equal(deleted.success, true)
          assert.equal(deleted.deleted_event_id, (toolResults.get('create-event') as { event_id: number }).event_id)
          return response({ tool_calls: [{ index: 0, id: 'canvas-batch', type: 'function', function: { name: 'canvas_batch',
            arguments: JSON.stringify({ canvas_id: 1, request_id: 'runtime-canvas-delete', operations: [{ kind: 'delete_note', node_id: 1 }] }) } }] }, 'tool_calls')
        }
        if (requests.length === 5) {
          const batch = toolResults.get('canvas-batch') as { atomic: boolean; canvas_id: number; operations: Array<{ kind: string; deleted_node_id?: number; can_restore?: boolean; index: number }>; request_id: string }
          assert.deepEqual(batch, { atomic: true, canvas_id: 1, operations: [{ kind: 'delete_note', deleted_node_id: 1, can_restore: true, index: 0 }], request_id: 'runtime-canvas-delete' })
          return response({ tool_calls: [{ index: 0, id: 'canvas-delete-note', type: 'function', function: { name: 'canvas_delete_note',
            arguments: JSON.stringify({ node_id: 2 }) } }] }, 'tool_calls')
        }
        if (requests.length === 6) {
          assert.deepEqual(toolResults.get('canvas-delete-note'), { can_restore: true, deleted_node_id: 2 })
          return response({ tool_calls: [{ index: 0, id: 'canvas-disconnect', type: 'function', function: { name: 'canvas_disconnect',
            arguments: JSON.stringify({ canvas_id: 1, relation_id: 1 }) } }] }, 'tool_calls')
        }
        if (requests.length === 7) {
          assert.deepEqual(toolResults.get('canvas-disconnect'), { deleted_relation_id: 1 })
          return response({ tool_calls: [{ index: 0, id: 'canvas-delete', type: 'function', function: { name: 'canvas_delete',
            arguments: JSON.stringify({ canvas_id: 2 }) } }] }, 'tool_calls')
        }
        assert.equal(requests.length, 8)
        assert.deepEqual(toolResults.get('canvas-delete'), { deleted: true, canvas_id: 2, title: 'Runtime 待删画布' })
        return response({ content: '活动已处理，画布便签已删除。' }, 'stop')
      } } },
    })
    let events: RunEvent[] = []
    for await (const event of instance.harness.start(identity)) events.push(event)
    assert.equal(requests.length, 3, JSON.stringify(events))
    assert.equal(events.at(-1)?.type, 'interaction_required')
    const deleteIntent = deleteConfirmation.intent!
    assert.equal(pendingConfirmationId, deleteIntent.interactionId)
    const eventId = (toolResults.get('create-event') as { event_id: number }).event_id
    const waitingEvent = await runtimeDb.db.selectFrom('calendar_events').select(['user_id', 'title', 'deleted_at']).where('id', '=', eventId).executeTakeFirstOrThrow()
    assert.equal(waitingEvent.title, 'Runtime 活动已更新')
    assert.equal(waitingEvent.deleted_at, null, '确认前不能产生删除副作用')
    const deleteReceipt = deleteConfirmation.approve('synthetic-delete-event-receipt')
    const resumedEvents: RunEvent[] = []
    for await (const event of instance.harness.resume(identity, {
      interactionId: deleteIntent.interactionId, receiptId: deleteReceipt, status: 'confirmed', value: null,
    })) resumedEvents.push(event)
    events = [...events, ...resumedEvents]
    assert.equal(requests.length, 4)
    assert.equal(resumedEvents.at(-1)?.type, 'interaction_required')
    const canvasIntent = canvasConfirmation.intent!
    assert.equal(pendingConfirmationId, canvasIntent.interactionId)
    assert.equal((await runtimeDb.db.selectFrom('mind_nodes').select('deleted_at').where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at, null,
      '画布便签确认前不能产生删除副作用')
    const canvasItemBeforeConfirmation = await runtimeDb.db.selectFrom('mind_canvas_items').select('deleted_at').where('id', '=', 1).executeTakeFirstOrThrow()
    assert.equal(canvasItemBeforeConfirmation.deleted_at, null)
    const undoCountBeforeCanvas = await runtimeDb.db.selectFrom('undo_operations').select('id').execute().then(rows => rows.length)
    const canvasReceipt = canvasConfirmation.approve('synthetic-canvas-receipt')
    const canvasResumeEvents: RunEvent[] = []
    for await (const event of instance.harness.resume(identity, {
      interactionId: canvasIntent.interactionId, receiptId: canvasReceipt, status: 'confirmed', value: null,
    })) canvasResumeEvents.push(event)
    events = [...events, ...canvasResumeEvents]
    assert.equal(requests.length, 5)
    assert.equal(canvasResumeEvents.at(-1)?.type, 'interaction_required')
    const deleteNoteIntent = deleteNoteConfirmation.intent!
    assert.equal(pendingConfirmationId, deleteNoteIntent.interactionId)
    assert.equal((await runtimeDb.db.selectFrom('mind_nodes').select('deleted_at').where('id', '=', 2).executeTakeFirstOrThrow()).deleted_at, null,
      '独立便签确认前不能产生删除副作用')
    const undoCountBeforeDeleteNote = await runtimeDb.db.selectFrom('undo_operations').select('id').execute().then(rows => rows.length)
    const deleteNoteReceipt = deleteNoteConfirmation.approve('synthetic-canvas-note-receipt')
    const deleteNoteResumeEvents: RunEvent[] = []
    for await (const event of instance.harness.resume(identity, {
      interactionId: deleteNoteIntent.interactionId, receiptId: deleteNoteReceipt, status: 'confirmed', value: null,
    })) deleteNoteResumeEvents.push(event)
    events = [...events, ...deleteNoteResumeEvents]
    assert.equal(requests.length, 6)
    assert.equal(deleteNoteResumeEvents.at(-1)?.type, 'interaction_required', JSON.stringify({ events: deleteNoteResumeEvents, results: [...toolResults] }))
    const disconnectIntent = disconnectConfirmation.intent!
    assert.equal(pendingConfirmationId, disconnectIntent.interactionId)
    assert.equal((await runtimeDb.db.selectFrom('mind_relations').select('deleted_at').where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at, null,
      '关系确认前不能产生删除副作用')
    const undoCountBeforeDisconnect = await runtimeDb.db.selectFrom('undo_operations').select('id').execute().then(rows => rows.length)
    const disconnectReceipt = disconnectConfirmation.approve('synthetic-disconnect-receipt')
    const disconnectResumeEvents: RunEvent[] = []
    for await (const event of instance.harness.resume(identity, {
      interactionId: disconnectIntent.interactionId, receiptId: disconnectReceipt, status: 'confirmed', value: null,
    })) disconnectResumeEvents.push(event)
    events = [...events, ...disconnectResumeEvents]
    assert.equal(requests.length, 7)
    assert.equal(disconnectResumeEvents.at(-1)?.type, 'interaction_required')
    const deleteCanvasIntent = deleteCanvasConfirmation.intent!
    assert.equal(pendingConfirmationId, deleteCanvasIntent.interactionId)
    assert.equal((await runtimeDb.db.selectFrom('mind_maps').select('deleted_at').where('id', '=', 2).executeTakeFirstOrThrow()).deleted_at, null,
      '级联画布确认前不能产生删除副作用')
    const undoCountBeforeDeleteCanvas = await runtimeDb.db.selectFrom('undo_operations').select('id').execute().then(rows => rows.length)
    const deleteCanvasReceipt = deleteCanvasConfirmation.approve('synthetic-canvas-delete-receipt')
    const deleteCanvasResumeEvents: RunEvent[] = []
    for await (const event of instance.harness.resume(identity, {
      interactionId: deleteCanvasIntent.interactionId, receiptId: deleteCanvasReceipt, status: 'confirmed', value: null,
    })) deleteCanvasResumeEvents.push(event)
    events = [...events, ...deleteCanvasResumeEvents]
    assert.equal(requests.length, 8)
    assert.equal(events.at(-1)?.payload.status, 'completed', JSON.stringify({ events, results: [...toolResults] }))
    assert.deepEqual(events.filter(event => event.type === 'tool_done').map(event => ({ toolCallId: event.payload.toolCallId, status: event.payload.status })), [
      { toolCallId: 'create-event', status: 'success' }, { toolCallId: 'update-event', status: 'success' },
      { toolCallId: 'delete-event', status: 'waiting' }, { toolCallId: 'delete-event', status: 'success' },
      { toolCallId: 'canvas-batch', status: 'waiting' }, { toolCallId: 'canvas-batch', status: 'success' },
      { toolCallId: 'canvas-delete-note', status: 'waiting' }, { toolCallId: 'canvas-delete-note', status: 'success' },
      { toolCallId: 'canvas-disconnect', status: 'waiting' }, { toolCallId: 'canvas-disconnect', status: 'success' },
      { toolCallId: 'canvas-delete', status: 'waiting' }, { toolCallId: 'canvas-delete', status: 'success' },
    ])
    const storedEvent = await runtimeDb.db.selectFrom('calendar_events').select(['user_id', 'title', 'deleted_at']).where('id', '=', eventId).executeTakeFirstOrThrow()
    assert.equal(storedEvent.user_id, opened.ownerId.replaceAll('-', ''))
    assert.equal(storedEvent.title, 'Runtime 活动已更新')
    assert.ok(storedEvent.deleted_at)
    const reminder = await runtimeDb.db.selectFrom('scheduled_tasks')
      .select(['name', 'payload', 'cron', 'schedule_kind', 'start_at', 'reminder_lead_minutes', 'channels', 'delivery_targets', 'enabled'])
      .where('event_id', '=', eventId).executeTakeFirstOrThrow()
    assert.equal(reminder.name, 'Runtime 活动已更新 提醒')
    assert.equal(reminder.payload, '提醒：Runtime 活动已更新（2099-12-02 10:00）')
    assert.equal(reminder.cron, '@once:2099-12-02T01:30:00+00:00')
    assert.equal(reminder.schedule_kind, 'once')
    assert.equal(String(reminder.start_at), '2099-12-02 01:30:00.000000')
    assert.equal(reminder.reminder_lead_minutes, 30)
    assert.equal(reminder.channels, 'qq')
    assert.deepEqual(JSON.parse(String(reminder.delivery_targets)), { qq: { platform: 'qq', chat_type: 'c2c', puid: 'synthetic-target' } })
    assert.equal(reminder.enabled, 0)
    const deletedNote = await runtimeDb.db.selectFrom('mind_nodes').select('deleted_at').where('id', '=', 1).executeTakeFirstOrThrow()
    assert.ok(deletedNote.deleted_at)
    const deletedCanvasItem = await runtimeDb.db.selectFrom('mind_canvas_items').select('deleted_at').where('id', '=', 1).executeTakeFirstOrThrow()
    assert.ok(deletedCanvasItem.deleted_at)
    assert.ok((await runtimeDb.db.selectFrom('mind_nodes').select('deleted_at').where('id', '=', 2).executeTakeFirstOrThrow()).deleted_at)
    assert.ok((await runtimeDb.db.selectFrom('mind_relations').select('deleted_at').where('id', '=', 1).executeTakeFirstOrThrow()).deleted_at)
    assert.ok((await runtimeDb.db.selectFrom('mind_maps').select('deleted_at').where('id', '=', 2).executeTakeFirstOrThrow()).deleted_at)
    assert.equal((await runtimeDb.db.selectFrom('mind_nodes').select('deleted_at').where('id', '=', 5).executeTakeFirstOrThrow()).deleted_at, null,
      '级联删除画布保留便签来源节点')
    assert.ok((await runtimeDb.db.selectFrom('mind_canvas_items').select('deleted_at').where('id', '=', 5).executeTakeFirstOrThrow()).deleted_at)
    assert.equal(undoCountBeforeDeleteNote, undoCountBeforeCanvas + 1)
    assert.equal(undoCountBeforeDisconnect, undoCountBeforeDeleteNote + 1)
    assert.equal(undoCountBeforeDeleteCanvas, undoCountBeforeDisconnect)
    assert.equal(await runtimeDb.db.selectFrom('undo_operations').select('id').execute().then(rows => rows.length), undoCountBeforeDeleteCanvas)
  } finally {
    await instance?.close()
    providerBinding?.release()
    await runtimeDb?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

function response(delta: Record<string, unknown>, finish: string) {
  return { status: 200, headers: {}, body: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  })(), cancel: async () => {} }
}
