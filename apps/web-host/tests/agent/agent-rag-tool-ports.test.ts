import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sql } from 'kysely'
import { createKyselyDashboardCounter, dataContext } from '@gugu/core'
import { createKyselyProjectCreateRuntime } from '@gugu/core/project-create-data'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createAgentMindReader, createAgentPlaceableSearch, createSqlMindCanvasReader } from '@gugu/core/mind'
import { createCanvasCreationPort, createClientDeletePort, createDurableProjectMutationPort, createWebLinkButtonDeliveryPort, createWorkspaceMutationPort } from '@gugu/core/tools'
import type { ClientDeleteConfirmationPort } from '@gugu/core/tools'
import { createWebAgentCanvasMutationPorts } from '../../src/domains/agent-sessions/tools/agent-canvas-write-ports.js'
import { createKyselyScheduledTaskReader, createScheduledTaskQueries } from '@gugu/core/scheduled-task-list'
import { createAgentCalendarReader, createKyselyCalendarAgentReadPort, createKyselyCalendarReadPort } from '@gugu/core/calendar'
import { createAgentWorkspaceQueries, createKyselyAgentWorkspaceReader } from '@gugu/core/workspaces'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { createMcpAgentToolPorts } from '../../src/domains/agent-sessions/tools/agent-mcp-tool-ports.js'
import { createWebAgentRagToolPorts } from '../../src/domains/agent-sessions/tools/agent-rag-tool-ports.js'
import { createWebAgentProductionRagContextBuilder, createWebAgentProductionRagToolPorts, createWebAgentProductionRagRunPorts, createAuthorizedWebAgentProductionRagRunPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentProductionToolRegistry } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createWebAgentRagRunAuthorization } from '../../src/domains/agent-sessions/tools/agent-rag-run-authorization.js'
import type { WebCalendarCanvasToolName } from '../../src/domains/agent-sessions/tools/agent-rag-run-authorization.js'
import { createWebAgentToolPorts } from '../../src/domains/agent-sessions/agent-web-reconstructor.js'
import { createWebAgentRagContextBuilder } from '../../src/domains/agent-sessions/tools/agent-rag-context.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'
import { createGlobalSearchOperations } from '../../../../packages/core/src/search/global-search.js'
import { createKyselySqliteGlobalSearchSources } from '../../../../packages/core/src/search/sqlite.js'
import { buildRunRagContext } from '@gugu/core/agent'

test('Web RAG 组合端口经真实注册器同时接通 conversation 与 owner memory 搜索', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-ports-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const databasePath = join(directory, 'core.db')
    const storageRoot = join(directory, 'storage')
    await initializeSqlite(databasePath)
    const opened = await openSqliteRuntime(databasePath)
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const ownerKey = ownerId.replaceAll('-', '')
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(rows: Record<string, unknown> | Record<string, unknown>[]): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values({ id: 71, user_id: ownerKey, title: '发布计划', title_locked: 0,
      summary: '周五版本发布', source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T03:04:00Z' }).execute()
    await fixtureDb.insertInto('conversation_messages').values({ session_id: 71, conversation_seq: 1, role: 'user',
      content: '周五完成部署复盘。', created_at: '2026-01-02T03:00:00Z' }).execute()

    const memoryDirectory = join(storageRoot, ownerId, '.agent', 'rag', 'memory')
    await mkdir(memoryDirectory, { recursive: true })
    await writeFile(join(memoryDirectory, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '偏好', summary: '部署习惯', content: '发布前先检查回归测试',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'foreign:0', parent_document_id: 'memory:foreign', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '其他用户', summary: '', content: '不应泄漏的发布安排',
        version: 'profile-v1', scope: { owner_user_id: '08a80873-5266-43b9-a27c-d288b602a9cb', scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')

    const ragPorts = createWebAgentRagToolPorts({ core: runtime, storageRoot,
      async authorizeMemory(identity, _signal, scopes) {
        return identity.ownerId === ownerId && scopes?.every(scope => scope.ownerId === ownerId) === true
      },
      async snapshot(identity) { assert.equal(identity.ownerId, ownerId); return { revision: 'snapshot-v1', text: '' } },
    })
    const registry = createAgentToolRegistry({ core: runtime, ...ragPorts,
      authorize: async (identity, name) => identity.ownerId === ownerId && ['search_conversations', 'search_memory'].includes(name) })
    const identity = { ownerId, sessionId: '71', runId: 'web-rag-test' }
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('RAG 只读工具不得调用执行后端') } }

    const definitions = await registry.capabilities(identity)
    assert.deepEqual(definitions.filter(item => ['search_conversations', 'search_memory'].includes(item.name)).map(item => item.name).sort(),
      ['search_conversations', 'search_memory'])

    const conversation = await registry.tools.dispatch({ id: 'conversation', name: 'search_conversations', input: { query: '部署' } }, scope)
    assert.equal(conversation.kind === 'completed' && conversation.successful, true)
    assert.match(JSON.stringify(conversation), /周五完成部署复盘/u)

    const memory = await registry.tools.dispatch({ id: 'memory', name: 'search_memory', input: { query: '发布' } }, scope)
    assert.equal(memory.kind === 'completed' && memory.successful, true, JSON.stringify(memory))
    assert.match(JSON.stringify(memory), /发布前先检查回归测试/u)
    assert.doesNotMatch(JSON.stringify(memory), /不应泄漏的发布安排/u)

    await writeFile(join(storageRoot, ownerId, '.agent', 'memory_vec.json'), JSON.stringify({
      'rag:memory:profile:profile-v1:0': { t: 'synthetic:embedding-v1:2', v: [1, 0] },
    }), 'utf8')
    let embeddingCalls = 0
    const vectorPorts = createWebAgentRagToolPorts({ core: runtime, storageRoot,
      authorizeMemory: async identity => identity.ownerId === ownerId,
      async snapshot() { return { revision: 'snapshot-v1', text: '' } },
      embedding: {
        async resolve(owner) {
          assert.equal(owner, ownerId)
          return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1',
            apiKey: 'synthetic-key', dimensions: 2 }
        },
        createTransport() {
          return { async request(request, signal) {
            signal.throwIfAborted()
            assert.equal(request.url, 'https://embedding.example/v1/embeddings')
            embeddingCalls += 1
            return { status: 200, headers: {}, body: (async function* () {
              yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
            })(), async cancel() {} }
          } }
        },
      },
    })
    const vectorRegistry = createAgentToolRegistry({ core: runtime, ...vectorPorts,
      authorize: async (identity, name) => identity.ownerId === ownerId && name === 'search_memory' })
    const vectorResult = await vectorRegistry.tools.dispatch({ id: 'vector-memory', name: 'search_memory', input: { query: '发布' } }, scope)
    assert.equal(vectorResult.kind === 'completed' && vectorResult.successful, true, JSON.stringify(vectorResult))
    assert.equal((vectorResult.kind === 'completed' ? (vectorResult.value as { strategy: string }).strategy : ''), 'hybrid')
    assert.match(JSON.stringify(vectorResult), /发布前先检查回归测试/u)
    assert.equal(embeddingCalls, 1)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web Run 项目工具经可信 Core 端口及 lease 注册器实际执行', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-project-tools-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '71', runId: 'project-tools-run' }
    const lease = { identity, token: 'project-tools-lease', fence: 12, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 1, locale: 'zh-CN' as const, origin: null, accessVersion: 'f'.repeat(64), v: 2 as const, source: 'web' as const } }
    let active = true
    const pool = { async query(_query: string, values: unknown[]) {
      assert.deepEqual(values, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rowCount: active ? 1 : 0, rows: [] }
    } }
    const projects = createKyselyProjectCreateRuntime({ db: runtime.db, backend: 'sqlite', publishProjectCreated: async () => {} })
    const projectMutations = createDurableProjectMutationPort({ core: runtime, runtime: {
      async renameProjectDirectory() {}, async getFileCount() { return 0 }, async publishProjectUpdated() {},
    }, metadata: () => ({ undoContextId: `agent:${identity.sessionId}:${identity.runId}` }) })
    const ports = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool: pool as never, storageRoot: join(directory, 'storage'), lease,
      selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion, modelIdentity: 'synthetic-model' },
      enabled: async () => true, enabledProjectCreation: true, enabledProjectMutations: true, projects, projectMutations,
    })
    const capabilities = await ports.toolRegistry.capabilities(identity)
    for (const name of ['get_tool_schema', 'create_project', 'update_project', 'set_color', 'archive_project', 'add_stage', 'remove_stage', 'rename_stage', 'set_stages', 'update_stage'])
      assert.ok(capabilities.some(tool => tool.name === name), `${name} should be registered`)
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('项目工具必须经 Core 项目端口') } }
    const schema = await ports.toolRegistry.tools.dispatch({ id: 'project-schema', name: 'get_tool_schema', input: { tools: ['create_project', 'update_project'] } }, scope)
    assert.equal(schema.kind === 'completed' && schema.successful, true, JSON.stringify(schema))
    assert.match(JSON.stringify(schema), /update_project/u)
    const created = await ports.toolRegistry.tools.dispatch({ id: 'create-project', name: 'create_project', input: {
      project_name: 'Agent 合成项目', start_date: '2026-11-18', deadline: '2026-11-30',
    } }, scope)
    assert.equal(created.kind === 'completed' && created.successful && created.mutated, true, JSON.stringify(created))
    const projectId = Number((created.value as { project_id: number }).project_id)
    assert.ok(await runtime.transaction(dataContext(identity.ownerId), data => data.projects.get(projectId)))
    for (const [id, name, input] of [
      ['update-project', 'update_project', { project_id: projectId, status: 'active', priority: 'high' }],
      ['set-color', 'set_color', { project_id: projectId, color: 'teal' }],
      ['archive-project', 'archive_project', { project_id: projectId }],
      ['unarchive-project', 'archive_project', { project_id: projectId, archived: false }],
      ['add-stage', 'add_stage', { project_id: projectId, label: '复盘' }],
      ['rename-stage', 'rename_stage', { project_id: projectId, stage: '复盘', new_label: '复盘完成' }],
      ['update-stage', 'update_stage', { project_id: projectId, stage: '复盘完成', add: ['整理回归'] }],
      ['set-stages', 'set_stages', { project_id: projectId, stages: ['计划', '交付'] }],
      ['remove-stage', 'remove_stage', { project_id: projectId, stage: '计划' }],
    ] as const) {
      const result = await ports.toolRegistry.tools.dispatch({ id, name, input }, scope)
      assert.equal(result.kind === 'completed' && result.successful, true, `${name}: ${JSON.stringify(result)}`)
    }
    assert.equal((await runtime.transaction(dataContext(identity.ownerId), data => data.projects.get(projectId)))?.status, 'active')
    active = false
    const revoked = await ports.toolRegistry.tools.dispatch({ id: 'revoked-project', name: 'update_project', input: { project_id: projectId, status: 'done' } }, scope)
    assert.equal(revoked.kind === 'completed' && revoked.successful, false)
    assert.equal((await runtime.transaction(dataContext(identity.ownerId), data => data.projects.get(projectId)))?.status, 'active')
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web RAG Run 配置只公开只读工具并在每次授权时复验 PostgreSQL lease', async () => {
  const identity = { ownerId: 'owner-synthetic', sessionId: '41', runId: 'run-synthetic' }
  const lease = { identity, token: 'token-synthetic', fence: 7, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as const
  const signal = new AbortController().signal
  let isActive = true
  const queries: unknown[][] = []
  const authorization = createWebAgentRagRunAuthorization({ async query(sql: string, values: unknown[]) {
    assert.match(sql, /d\.token=\$4 AND d\.fence=\$5/u)
    queries.push(values)
    return { rowCount: isActive ? 1 : 0, rows: [] }
  } } as never, lease)
  const configuration = await authorization.configuration(identity, signal)
  assert.deepEqual(configuration.identity, { ownerId: identity.ownerId, workspaceId: null,
    subject: { kind: 'session', id: identity.sessionId } })
  assert.deepEqual(configuration.toolNames, ['search_conversations', 'search_memory', 'use_skill', 'list_skills', 'list_clients', 'list_projects', 'get_tool_schema'])
  assert.equal(configuration.toolNames.includes('ask_user'), false, '没有交互激活装配时不得暴露 ask_user')
  assert.equal(await authorization.authorize(identity, 'get_project', signal), false)
  assert.equal(await authorization.authorize(identity, 'create_project', signal), false)
  assert.equal(await authorization.authorize(identity, 'update_project', signal), false)
  assert.equal(await authorization.authorize(identity, 'get_tool_schema', signal), true)
  assert.equal(await authorization.authorize(identity, 'list_scheduled_tasks', signal), false)
  assert.equal(await authorization.authorize(identity, 'restore_file', signal), false)
  assert.equal(await authorization.authorize(identity, 'restore_folder', signal), false)
  assert.equal(await authorization.authorize(identity, 'read_conversation', signal), false)
  assert.equal(await authorization.authorize(identity, 'get_current_time', signal), false)
  assert.equal(await authorization.authorize(identity, 'list_events', signal), false)
  assert.equal(await authorization.authorize(identity, 'get_upcoming', signal), false)
  const conversationRead = createWebAgentRagRunAuthorization({ async query() {
    return { rowCount: isActive ? 1 : 0, rows: [] }
  } } as never, lease, { enabledConversationRead: true })
  assert.ok((await conversationRead.configuration(identity, signal)).toolNames.includes('read_conversation'))
  assert.equal(await conversationRead.authorize(identity, 'read_conversation', signal), true)
  assert.equal(await conversationRead.authorize({ ...identity, ownerId: 'other-owner' }, 'read_conversation', signal), false)
  assert.equal(configuration.source, 'web')
  assert.equal(await authorization.authorize(identity, 'search_conversations', signal), true)
  assert.equal(await authorization.authorize(identity, 'delete_project', signal), false)
  assert.equal(await authorization.authorize({ ...identity, ownerId: 'other-owner' }, 'search_memory', signal), false)
  isActive = false
  assert.equal(await authorization.authorize(identity, 'search_memory', signal), false)
  await assert.rejects(authorization.configuration(identity, signal), /授权不可用/u)
  assert.deepEqual(queries, Array.from({ length: 5 }, () => [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence]))
})

test('生产 Web Run 仅在 Host 提供共享搜索服务时注册 global_search 并按 lease 执行 owner 查询', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-global-search-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const databasePath = join(directory, 'core.db')
    await initializeSqlite(databasePath)
    const opened = await openSqliteRuntime(databasePath)
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const project = await runtime.transaction(dataContext(ownerId), data => data.projects.create({ name: '合成发布项目' }))
    const identity = { ownerId, sessionId: '81', runId: 'global-search-run' }
    const lease = { identity, token: 'global-search-lease', fence: 5,
      input: { userMessageId: 8, locale: 'zh-CN', origin: null, accessVersion: 'e'.repeat(64), v: 2, source: 'web' },
      mode: 'start', cancelRequested: false } as const
    const search = createGlobalSearchOperations(createKyselySqliteGlobalSearchSources(runtime.db))
    const pool = { async query(_sql: string, values: unknown[]) {
      assert.deepEqual(values, [ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rowCount: 1, rows: [] }
    } }
    const selection = { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: 'e'.repeat(64), modelIdentity: 'synthetic-model' }
    const withoutSearch = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool: pool as never, storageRoot: join(directory, 'storage'), lease,
      selection, enabled: async () => true,
    })
    assert.equal((await withoutSearch.configuration(identity, new AbortController().signal)).toolNames.includes('global_search'), false)
    assert.equal((await withoutSearch.toolRegistry.capabilities(identity)).some(tool => tool.name === 'global_search'), false)

    const withSearch = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool: pool as never, storageRoot: join(directory, 'storage'), lease,
      selection, enabled: async () => true, search, enabledGlobalSearch: true,
    })
    const configuration = await withSearch.configuration(identity, new AbortController().signal)
    assert.ok(configuration.toolNames.includes('global_search'))
    const definitions = await withSearch.toolRegistry.capabilities(identity)
    assert.ok(definitions.some(tool => tool.name === 'global_search'))
    const result = await withSearch.toolRegistry.tools.dispatch({ id: 'global-search', name: 'global_search', input: {
      query: '发布', types: ['project'], owner_id: 'forged-owner', per_type: 200,
    } }, { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('只读搜索不得调用执行后端') } })
    assert.equal(result.kind === 'completed' && result.successful, true, JSON.stringify(result))
    const value = result.kind === 'completed' ? result.value as { groups: Array<{ items: Array<{ id: number; title: string }> }> } : null
    assert.deepEqual(value?.groups.flatMap(group => group.items.map(item => ({ id: item.id, title: item.title }))),
      [{ id: project.id, title: '合成发布项目' }])
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('生产 Web Run 复用 Core 客户端工具，按可信 owner 创建、列出和更新联系人', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-clients-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const databasePath = join(directory, 'core.db')
    await initializeSqlite(databasePath)
    const opened = await openSqliteRuntime(databasePath)
    runtime = opened.runtime
    const ownerId = opened.ownerId, otherOwner = randomUUID()
    await runtime.transaction(dataContext(otherOwner), data => data.clients.create({ name: '他人联系人', notes: '私有' }))
    const identity = { ownerId, sessionId: '82', runId: 'client-tools-run' }
    const lease = { identity, token: 'client-tools-lease', fence: 6,
      input: { userMessageId: 9, locale: 'zh-CN', origin: null, accessVersion: 'f'.repeat(64), v: 2, source: 'web' },
      mode: 'start', cancelRequested: false } as const
    const pool = { async query(_sql: string, values: unknown[]) {
      assert.deepEqual(values, [ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rowCount: 1, rows: [] }
    } }
    const run = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool: pool as never, storageRoot: join(directory, 'storage'), lease,
      selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion, modelIdentity: 'synthetic-model' },
      enabled: async () => true, enabledClientTools: true,
    })
    const configuration = await run.configuration(identity, new AbortController().signal)
    for (const name of ['list_clients', 'create_client', 'update_client']) assert.ok(configuration.toolNames.includes(name))
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('联系人工具不得调用执行后端') } }
    const created = await run.toolRegistry.tools.dispatch({ id: 'create-client', name: 'create_client', input: {
      client_name: '合成联系人', email: 'synthetic@example.test', owner_id: otherOwner,
    } }, scope)
    assert.equal(created.kind === 'completed' && created.successful, true, JSON.stringify(created))
    const createdValue = created.kind === 'completed' ? created.value as { client_id: number; name: string } : null
    assert.equal(createdValue?.name, '合成联系人')

    const updated = await run.toolRegistry.tools.dispatch({ id: 'update-client', name: 'update_client', input: {
      client_id: createdValue!.client_id, phone: '000-0000',
    } }, scope)
    assert.equal(updated.kind === 'completed' && updated.successful, true, JSON.stringify(updated))
    const listed = await run.toolRegistry.tools.dispatch({ id: 'list-clients', name: 'list_clients', input: {} }, scope)
    assert.equal(listed.kind === 'completed' && listed.successful, true, JSON.stringify(listed))
    assert.deepEqual(listed.kind === 'completed' ? listed.value : null, [{ id: createdValue!.client_id,
      name: '合成联系人', contact: null, email: 'synthetic@example.test', phone: '000-0000', notes: '' }])
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web Agent 按 Host 显式启用知识/日历/画布工具，并对其每次复验当前 dispatch lease', async () => {
  const identity = { ownerId: 'owner-synthetic', sessionId: '41', runId: 'run-synthetic' }
  const lease = { identity, token: 'token-synthetic', fence: 7, input: { v: 2, source: 'web' }, mode: 'start', cancelRequested: false } as const
  const signal = new AbortController().signal
  let isActive = true
  const authorization = createWebAgentRagRunAuthorization({ async query() {
    return { rowCount: isActive ? 1 : 0, rows: [] }
  } } as never, lease, { enabledCalendarCanvasTools: ['create_event', 'canvas_batch'], enabledCalendarRead: true, enabledUpcoming: true,
    enabledKnowledgeRead: true, enabledKnowledgeWrites: true, enabledProjectOverview: true, enabledProjectCreation: true, enabledProjectMutations: true, enabledScheduledTasks: true, enabledTrashRestore: true,
    enabledWorkspaces: true, enabledWorkspaceMutations: true, enabledCanvasReads: true, enabledCanvasPlaceableSearch: true, enabledCanvasCreate: true, enabledCanvasMutations: true, enabledNoteReads: true, enabledNoteLifecycle: true })
  const withoutMindReads = createWebAgentRagRunAuthorization({ async query() { return { rowCount: 1, rows: [] } } } as never, lease)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('canvas_list'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('canvas_focus_node'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('canvas_search_placeable'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('canvas_create'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('canvas_get'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('canvas_create_note'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('note_delete'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('create_project'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('update_project'), false)
  assert.equal((await withoutMindReads.configuration(identity, signal)).toolNames.includes('update_workspace'), false)
  assert.equal(await withoutMindReads.authorize(identity, 'note_get', signal), false)
  assert.deepEqual((await authorization.configuration(identity, signal)).toolNames,
    ['search_conversations', 'search_memory', 'use_skill', 'list_skills', 'list_clients', 'list_projects', 'get_tool_schema', 'read_knowledge', 'save_knowledge', 'update_knowledge', 'list_events', 'get_upcoming', 'get_project', 'create_project', 'update_project', 'set_color', 'archive_project', 'add_stage', 'remove_stage', 'rename_stage', 'set_stages', 'update_stage', 'list_scheduled_tasks', 'list_workspaces', 'get_workspace', 'update_workspace', 'restore_file', 'restore_folder', 'canvas_list', 'canvas_get', 'canvas_search', 'canvas_focus_node', 'canvas_search_placeable', 'canvas_create', 'canvas_create_note', 'canvas_add_node', 'canvas_update_node', 'canvas_remove_node', 'canvas_update_note', 'canvas_update_anchor', 'canvas_connect', 'note_search', 'note_get', 'note_delete', 'note_restore', 'note_undo', 'create_event', 'canvas_batch'])
  assert.equal(await authorization.authorize(identity, 'read_knowledge', signal), true)
  assert.equal(await authorization.authorize(identity, 'save_knowledge', signal), true)
  assert.equal(await authorization.authorize(identity, 'update_knowledge', signal), true)
  assert.equal(await authorization.authorize(identity, 'use_skill', signal), true)
  assert.equal(await authorization.authorize(identity, 'list_clients', signal), true)
  assert.equal(await authorization.authorize(identity, 'list_projects', signal), true)
  assert.equal(await authorization.authorize(identity, 'get_project', signal), true)
  for (const name of ['get_tool_schema', 'create_project', 'update_project', 'set_color', 'archive_project', 'add_stage', 'remove_stage', 'rename_stage', 'set_stages', 'update_stage']) assert.equal(await authorization.authorize(identity, name, signal), true)
  assert.equal(await authorization.authorize(identity, 'list_scheduled_tasks', signal), true)
  assert.equal(await authorization.authorize(identity, 'restore_file', signal), true)
  assert.equal(await authorization.authorize(identity, 'update_workspace', signal), true)
  assert.equal(await authorization.authorize(identity, 'restore_folder', signal), true)
  assert.equal(await authorization.authorize(identity, 'canvas_list', signal), true)
  assert.equal(await authorization.authorize(identity, 'canvas_focus_node', signal), true)
  assert.equal(await authorization.authorize(identity, 'canvas_search_placeable', signal), true)
  assert.equal(await authorization.authorize(identity, 'canvas_create', signal), true)
  for (const name of ['canvas_create_note', 'canvas_add_node', 'canvas_update_node', 'canvas_remove_node', 'canvas_update_note', 'canvas_update_anchor', 'canvas_connect', 'note_delete', 'note_restore', 'note_undo']) assert.equal(await authorization.authorize(identity, name, signal), true)
  assert.equal(await authorization.authorize(identity, 'canvas_get', signal), true)
  assert.equal(await authorization.authorize(identity, 'canvas_search', signal), true)
  assert.equal(await authorization.authorize(identity, 'note_search', signal), true)
  assert.equal(await authorization.authorize(identity, 'note_get', signal), true)
  assert.equal(await authorization.authorize(identity, 'create_event', signal), true)
  assert.equal(await authorization.authorize(identity, 'list_events', signal), true)
  assert.equal(await authorization.authorize(identity, 'get_upcoming', signal), true)
  assert.equal(await authorization.authorize(identity, 'update_event', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_batch', signal), true)
  assert.equal(await authorization.authorize({ ...identity, sessionId: '42' }, 'canvas_batch', signal), false)
  isActive = false
  assert.equal(await authorization.authorize(identity, 'create_event', signal), false)
  assert.equal(await authorization.authorize(identity, 'read_knowledge', signal), false)
  assert.equal(await authorization.authorize(identity, 'list_events', signal), false)
  assert.equal(await authorization.authorize(identity, 'get_upcoming', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_list', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_focus_node', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_search_placeable', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_create', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_update_node', signal), false)
  assert.equal(await authorization.authorize(identity, 'note_delete', signal), false)
  assert.equal(await authorization.authorize(identity, 'save_knowledge', signal), false)
  assert.equal(await authorization.authorize(identity, 'list_clients', signal), false)
  assert.equal(await authorization.authorize(identity, 'list_projects', signal), false)
  assert.equal(await authorization.authorize(identity, 'get_project', signal), false)
  assert.equal(await authorization.authorize(identity, 'list_scheduled_tasks', signal), false)
  assert.equal(await authorization.authorize(identity, 'update_workspace', signal), false)
  assert.equal(await authorization.authorize(identity, 'restore_file', signal), false)
  assert.equal(await authorization.authorize(identity, 'restore_folder', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_get', signal), false)
  assert.equal(await authorization.authorize(identity, 'canvas_search', signal), false)
  assert.equal(await authorization.authorize(identity, 'note_search', signal), false)
  assert.equal(await authorization.authorize(identity, 'note_get', signal), false)
  assert.throws(() => createWebAgentRagRunAuthorization({ async query() { return { rowCount: 1, rows: [] } } } as never,
    lease, { enabledCalendarCanvasTools: ['create_project' as WebCalendarCanvasToolName] }), /授权配置无效/u)
})

test('ask_user 仅在生产 Host 显式启用时发现，并在每次调用时复验活动 lease', async () => {
  const identity = { ownerId: 'owner-synthetic', sessionId: '41', runId: 'run-synthetic' }
  const lease = { identity, token: 'token-synthetic', fence: 7, input: { v: 2, source: 'web', accessVersion: 'a'.repeat(64) }, mode: 'start', cancelRequested: false } as const
  let active = true
  const pool = { async query() { return { rowCount: active ? 1 : 0, rows: [] } } }
  const make = (enabledAskUser: boolean) => createAuthorizedWebAgentProductionRagRunPorts({
    core: {} as never, pool: pool as never, storageRoot: '/tmp/gugu-agent-ask-user-test', lease,
    selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: 'a'.repeat(64), modelIdentity: 'synthetic-model' },
    enabled: async () => true, enabledAskUser,
  })
  const disabled = make(false)
  assert.equal((await disabled.configuration(identity, new AbortController().signal)).toolNames.includes('ask_user'), false)
  const enabled = make(true)
  assert.equal((await enabled.configuration(identity, new AbortController().signal)).toolNames.includes('ask_user'), true)
  const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
    execute: async () => { throw new Error('澄清交互不得执行宿主命令') } }
  const call = { id: 'ask-choice', name: 'ask_user', input: { kind: 'choice', title: '请选择', body: '合成澄清', options: [{ id: 'left', label: '左侧' }] } }
  const waiting = await enabled.toolRegistry.tools.dispatch(call, scope)
  assert.equal(waiting.kind, 'waiting')
  if (waiting.kind === 'waiting') {
    assert.equal(waiting.interaction.kind, 'question')
    assert.equal(waiting.interaction.toolCall.id, call.id)
  }
  active = false
  const denied = await enabled.toolRegistry.tools.dispatch({ ...call, id: 'ask-after-revoke' }, scope)
  assert.equal(denied.kind === 'completed' && denied.executed, false)
})

test('生产 RAG 组合仅在 Host 提供可信端口时发现并分派历史、时间和日历读取工具', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-read-conversation-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '71', runId: 'read-conversation-run' }
    const ownProject = await runtime.transaction(dataContext(identity.ownerId), data => data.projects.create({ name: '合成项目', status: 'active' }))
    const ownClient = await runtime.transaction(dataContext(identity.ownerId), data => data.clients.create({ name: '合成联系人' }))
    const otherOwner = '22222222-2222-4222-8222-222222222222'
    await runtime.transaction(dataContext(otherOwner), async data => {
      await data.projects.create({ name: '他人项目' })
      await data.clients.create({ name: '他人联系人' })
    })
    // Core SQLite 不安装 Host 文件 schema；显式最小化模拟共享读取端口需要的真实列。
    await sql`CREATE TABLE files(id INTEGER PRIMARY KEY,user_id TEXT,deleted_at TEXT)`.execute(runtime.db)
    await sql`INSERT INTO files VALUES (1,${identity.ownerId.replaceAll('-', '')},NULL),
      (2,${identity.ownerId.replaceAll('-', '')},'2026-01-01'),(3,${otherOwner.replaceAll('-', '')},NULL)`.execute(runtime.db)
    await sql`CREATE TABLE workspaces(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT,kind TEXT,enabled INTEGER,is_default INTEGER,
      project_id INTEGER,folder_id INTEGER,directory_id INTEGER,updated_at TEXT)`.execute(runtime.db)
    await sql`CREATE TABLE folders(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT)`.execute(runtime.db)
    await sql`CREATE TABLE workspace_directories(id INTEGER PRIMARY KEY,user_id TEXT,name TEXT)`.execute(runtime.db)
    await sql`INSERT INTO workspaces VALUES
      (1,${identity.ownerId.replaceAll('-', '')},'合成工作区','project',0,0,${ownProject.id},NULL,NULL,'2026-01-02'),
      (2,${otherOwner.replaceAll('-', '')},'他人工作区','directory',1,0,NULL,NULL,90,'2026-01-02')`.execute(runtime.db)
    await runtime.db.insertInto('calendar_events').values({ id: 8001, user_id: opened.ownerId.replaceAll('-', ''), title: '合成日程', date: '2026-01-04', type: 'event', version: 1,
      created_at: '2026-01-01 00:00:00', deleted_at: null }).execute()
    await sql`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,channels,enabled,delivery_targets,authorized_tools,email_attachment_file_ids,created_at,updated_at)
      VALUES(9001,${identity.ownerId.replaceAll('-', '')},NULL,'自有任务','私有指令','0 9 * * *','cron','web',1,'{}','[]','[]','2026-01-01 00:00:00','2026-01-01 00:00:00'),
        (9002,${identity.ownerId.replaceAll('-', '')},8001,'日历提醒','提醒内容','0 9 * * *','cron','web',1,'{}','[]','[]','2026-01-01 00:00:00','2026-01-01 00:00:00'),
        (9003,${otherOwner.replaceAll('-', '')},NULL,'他人任务','他人指令','0 9 * * *','cron','web',1,'{}','[]','[]','2026-01-01 00:00:00','2026-01-01 00:00:00')`.execute(runtime.db)
    const lease = { identity, token: 'lease-synthetic', fence: 4, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 1, locale: 'zh-CN' as const, origin: null, accessVersion: 'd'.repeat(64), v: 2 as const, source: 'web' as const } }
    let leaseActive = true
    const pool = { async query(_sql: string, values: unknown[]) {
      assert.deepEqual(values, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rowCount: leaseActive ? 1 : 0, rows: [] }
    } }
    const withHistory = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool: pool as never, storageRoot: join(directory, 'storage'), lease,
      selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion, modelIdentity: 'synthetic-model' },
      enabled: async () => true,
      enabledConversationRead: true,
      enabledTime: true,
      enabledCalendarRead: true,
      enabledUpcoming: true,
      enabledDashboard: true,
      enabledProjectOverview: true,
      enabledScheduledTasks: true,
      enabledLinkButtons: true,
      enabledWorkspaces: true,
      enabledWorkspaceMutations: true,
      enabledTrashList: true,
      enabledTrashRestore: true,
      conversations: { async read(candidate, sessionId) {
        assert.equal(candidate.ownerId, identity.ownerId)
        assert.equal(sessionId, 71)
        return { session_id: 71, title: '合成历史', source: 'web', messages: [{ role: '你', content: 'owner 正文' }] }
      } },
      time: { now: () => new Date('2026-01-02T04:05:06Z'), async timezone(candidate) {
        assert.equal(candidate.ownerId, identity.ownerId)
        return 'Asia/Shanghai'
      } },
      calendar: createAgentCalendarReader(createKyselyCalendarAgentReadPort(runtime.db, 'sqlite')),
      events: createKyselyCalendarReadPort(runtime.db, 'sqlite'),
      dashboard: createKyselyDashboardCounter(runtime.db, 'sqlite'),
      workspaces: createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(runtime.db, 'sqlite')),
      workspaceMutations: createWorkspaceMutationPort(runtime),
      trash: { async list(candidate, limit, signal) {
        assert.equal(candidate.ownerId, identity.ownerId)
        assert.equal(limit, 1)
        signal.throwIfAborted()
        return {
          files: [{ id: 41, file_id: 41, kind: 'file', name: '自有文件.txt', space: 'personal', deleted_at: '2026-01-01T00:00:00.000002Z' }],
          folders: [{ id: 42, folder_id: 42, kind: 'folder', name: '自有目录', space: 'personal', deleted_at: '2026-01-02T00:00:00.000003Z' }],
        }
      } },
      trashRestore: {
        async apply(input) {
          input.signal.throwIfAborted()
          assert.deepEqual(input.identity, identity)
          assert.equal(input.roundId, '1')
          return { kind: 'completed', successful: true, mutated: true,
            value: input.kind === 'file' ? { success: true, file_id: input.id } : { success: true, folder_id: input.id, name: '合成目录' } }
        },
        async reconcile() { return { kind: 'unknown' } },
      },
      linkButtons: createWebLinkButtonDeliveryPort(candidate => candidate.ownerId === identity.ownerId
        && candidate.sessionId === identity.sessionId && candidate.runId === identity.runId),
      fileOverview: async (candidate, projectId, signal) => {
        signal.throwIfAborted()
        assert.equal(candidate.ownerId, identity.ownerId)
        assert.equal(projectId, ownProject.id)
        return { total_file_count: 3, root_file_count: 1, total_folder_count: 2 }
      },
      scheduledTasks: { list: (candidate, signal) => createScheduledTaskQueries(
        createKyselyScheduledTaskReader(runtime!.db, 'sqlite'),
        () => ({ workspaceSupported: false, filesystemAuthorizationEnabled: false }),
        () => '2026-01-02T00:00:00Z',
      ).agent(candidate.ownerId, signal) },
    })
    const configuration = await withHistory.configuration(identity, new AbortController().signal)
    assert.ok(configuration.toolNames.includes('read_conversation'))
    assert.ok(configuration.toolNames.includes('get_current_time'))
    assert.ok(configuration.toolNames.includes('list_clients'))
    assert.ok(configuration.toolNames.includes('list_projects'))
    assert.ok(configuration.toolNames.includes('list_events'))
    assert.ok(configuration.toolNames.includes('get_upcoming'))
    assert.ok(configuration.toolNames.includes('get_dashboard_stats'))
    assert.ok(configuration.toolNames.includes('list_workspaces'))
    assert.ok(configuration.toolNames.includes('get_workspace'))
    assert.ok(configuration.toolNames.includes('list_trash'))
    assert.ok(configuration.toolNames.includes('restore_file'))
    assert.ok(configuration.toolNames.includes('restore_folder'))
    assert.ok(configuration.toolNames.includes('send_link_buttons'))
    assert.ok(configuration.toolNames.includes('get_project'))
    assert.ok(configuration.toolNames.includes('list_scheduled_tasks'))
    const definitions = await withHistory.toolRegistry.capabilities(identity)
    assert.ok(definitions.some(tool => tool.name === 'read_conversation'))
    assert.ok(definitions.some(tool => tool.name === 'get_current_time'))
    assert.ok(definitions.some(tool => tool.name === 'list_clients'))
    assert.ok(definitions.some(tool => tool.name === 'list_projects'))
    assert.ok(definitions.some(tool => tool.name === 'list_events'))
    assert.ok(definitions.some(tool => tool.name === 'get_upcoming'))
    assert.ok(definitions.some(tool => tool.name === 'get_dashboard_stats'))
    assert.ok(definitions.some(tool => tool.name === 'list_workspaces'))
    assert.ok(definitions.some(tool => tool.name === 'get_workspace'))
    assert.ok(definitions.some(tool => tool.name === 'list_trash'))
    assert.ok(definitions.some(tool => tool.name === 'restore_file'))
    assert.ok(definitions.some(tool => tool.name === 'restore_folder'))
    assert.ok(definitions.some(tool => tool.name === 'send_link_buttons'))
    const buttonCall = { id: 'button', name: 'send_link_buttons', input: { message: '入口', buttons: [
      { id: 'docs', label: '查看说明', url: 'https://example.test/docs' },
    ] } }
    const buttons = await withHistory.toolRegistry.tools.dispatch(buttonCall, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('Web 链接按钮必须通过 artifact 返回，不执行宿主命令') },
    })
    assert.deepEqual(buttons, { kind: 'completed', successful: true, mutated: false,
      value: { status: 'sent', platform: 'web', delivery: 'native', button_count: 1, message: '入口已在对话窗口以按钮展示。' },
      artifact: { kind: 'link_buttons', ...buttonCall.input } })
    leaseActive = false
    const revokedButtons = await withHistory.toolRegistry.tools.dispatch({ ...buttonCall, id: 'button-revoked' }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('撤销租约后不应执行链接按钮') },
    })
    assert.equal(revokedButtons.kind === 'completed' && revokedButtons.executed, false)
    leaseActive = true
    assert.ok(definitions.some(tool => tool.name === 'get_project'))
    assert.ok(definitions.some(tool => tool.name === 'list_scheduled_tasks'))
    const result = await withHistory.toolRegistry.tools.dispatch({ id: 'read', name: 'read_conversation', input: { session_id: 71 } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('历史读取不能调用执行后端') },
    })
    assert.deepEqual(result, { kind: 'completed', successful: true, mutated: false,
      value: { session_id: 71, title: '合成历史', source: 'web', messages: [{ role: '你', content: 'owner 正文' }] } })
    const time = await withHistory.toolRegistry.tools.dispatch({ id: 'time', name: 'get_current_time', input: { timezone: 'UTC' } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('时钟工具不能调用执行后端') },
    })
    assert.deepEqual(time, { kind: 'completed', successful: true, mutated: false,
      value: { date: '2026-01-02', weekday: '星期五', time: '12:05:06', datetime: '2026-01-02 12:05:06', timezone: 'Asia/Shanghai',
        ignored_fields: ['timezone'], hint: '以下字段不在 get_current_time 的当前 schema 中，已被忽略：timezone。参数形状与预期不符时，先调用 get_tool_schema 确认最新参数再重试。' } })
    const list = await withHistory.toolRegistry.tools.dispatch({ id: 'events', name: 'list_events', input: { from: '2026-01-04', to: '2026-01-04' } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('日历只读工具不能调用执行后端') },
    })
    assert.equal(list.kind === 'completed' && list.successful, true)
    if (list.kind !== 'completed') throw new Error('日历读取未完成')
    assert.equal((list.value as { id: number; title: string }[])[0]?.id, 8001)
    assert.equal((list.value as { id: number; title: string }[])[0]?.title, '合成日程')
    const upcoming = await withHistory.toolRegistry.tools.dispatch({ id: 'upcoming', name: 'get_upcoming', input: {} }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('近期安排只读工具不能调用执行后端') },
    })
    assert.equal(upcoming.kind === 'completed' && upcoming.successful, true)
    if (upcoming.kind !== 'completed') throw new Error('近期安排读取未完成')
    assert.deepEqual((upcoming.value as { from: string; to: string; items: { title: string }[] }).items.map(item => item.title), ['合成日程'])
    const trash = await withHistory.toolRegistry.tools.dispatch({ id: 'trash', name: 'list_trash', input: { limit: '１', owner_id: otherOwner } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('回收站只读工具不能调用执行后端') },
    })
    assert.equal(trash.kind === 'completed' && trash.successful, true, JSON.stringify(trash))
    assert.equal(trash.kind === 'completed' && trash.mutated, false)
    assert.equal(trash.kind === 'completed' && (trash.value as { items: { id: number }[] }).items[0]?.id, 42)
    assert.equal(trash.kind === 'completed' && (trash.value as { items: { deleted_at: string }[] }).items[0]?.deleted_at, '2026-01-02T00:00:00.000003Z')
    assert.deepEqual(trash.kind === 'completed' && (trash.value as { ignored_fields: string[] }).ignored_fields, ['[未声明字段]', 'owner_id'])
    assert.match(JSON.stringify(trash), /仅列出最近 1 个/u)
    assert.doesNotMatch(JSON.stringify(trash), /他人/u)
    const restored = await withHistory.toolRegistry.tools.dispatch({ id: 'restore-file', name: 'restore_file', input: { file_id: 41 } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('恢复工具必须经可信文件恢复端口') },
    })
    assert.deepEqual(restored, { kind: 'completed', successful: true, mutated: true, value: { success: true, file_id: 41 } })
    const restoredFolder = await withHistory.toolRegistry.tools.dispatch({ id: 'restore-folder', name: 'restore_folder', input: { folder_id: 42 } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('恢复工具必须经可信文件恢复端口') },
    })
    assert.deepEqual(restoredFolder, { kind: 'completed', successful: true, mutated: true,
      value: { success: true, folder_id: 42, name: '合成目录' } })
    const dashboard = await withHistory.toolRegistry.tools.dispatch({ id: 'dashboard', name: 'get_dashboard_stats', input: { owner_id: otherOwner } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('总览只读工具不能调用执行后端') },
    })
    assert.deepEqual(dashboard, { kind: 'completed', successful: true, mutated: false,
      value: { projects: { pending: 0, active: 1, done: 0, total: 1 }, upcoming_events: 1, files: 1, clients: 1,
        ignored_fields: ['owner_id'], hint: '以下字段不在 get_dashboard_stats 的当前 schema 中，已被忽略：owner_id。参数形状与预期不符时，先调用 get_tool_schema 确认最新参数再重试。' } })
    const project = await withHistory.toolRegistry.tools.dispatch({ id: 'project', name: 'get_project', input: { project_id: ownProject.id } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('项目详情只读工具不能调用执行后端') },
    })
    assert.equal(project.kind === 'completed' && project.successful, true, JSON.stringify(project))
    assert.equal(project.kind === 'completed' && (project.value as { files: { total_file_count: number } }).files.total_file_count, 3)
    const tasks = await withHistory.toolRegistry.tools.dispatch({ id: 'tasks', name: 'list_scheduled_tasks', input: { owner_id: otherOwner } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('定时任务只读工具不能调用执行后端') },
    })
    assert.equal(tasks.kind === 'completed' && tasks.successful, true, JSON.stringify(tasks))
    assert.deepEqual((tasks.value as { id: number; name: string }[]).map(task => task.id), [9001])
    assert.equal((tasks.value as { instruction: string }[])[0]?.instruction, '私有指令')
    const clients = await withHistory.toolRegistry.tools.dispatch({ id: 'clients', name: 'list_clients', input: {} }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('联系人只读工具不能调用执行后端') },
    })
    assert.equal(clients.kind === 'completed' && clients.successful, true)
    if (clients.kind !== 'completed') throw new Error('联系人读取未完成')
    assert.deepEqual((clients.value as { id: number; name: string }[]).map(client => client.name), ['合成联系人'])
    assert.equal((clients.value as { id: number; name: string }[])[0]?.id, ownClient.id)
    const projects = await withHistory.toolRegistry.tools.dispatch({ id: 'projects', name: 'list_projects', input: {} }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('项目只读工具不能调用执行后端') },
    })
    assert.equal(projects.kind === 'completed' && projects.successful, true)
    if (projects.kind !== 'completed') throw new Error('项目列表读取未完成')
    assert.deepEqual((projects.value as { id: number; name: string }[]).map(project => project.name), ['合成项目'])
    assert.equal((projects.value as { id: number; name: string }[])[0]?.id, ownProject.id)
    const workspaces = await withHistory.toolRegistry.tools.dispatch({ id: 'workspaces', name: 'list_workspaces', input: {} }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('工作区只读工具不能调用执行后端') },
    })
    assert.equal(workspaces.kind === 'completed' && workspaces.successful, true)
    if (workspaces.kind !== 'completed') throw new Error('工作区列表读取未完成')
    assert.deepEqual((workspaces.value as { workspace_id: number; name: string; enabled: boolean; project_name?: string }[]).map(item => ({
      id: item.workspace_id, name: item.name, enabled: item.enabled, project: item.project_name,
    })), [{ id: 1, name: '合成工作区', enabled: false, project: '合成项目' }])
    const ownWorkspace = await withHistory.toolRegistry.tools.dispatch({ id: 'workspace', name: 'get_workspace', input: { workspace_id: 1 } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('工作区详情只读工具不能调用执行后端') },
    })
    assert.equal(ownWorkspace.kind === 'completed' && ownWorkspace.successful, true)
    assert.equal((ownWorkspace.value as { name: string }).name, '合成工作区')
    const foreignWorkspace = await withHistory.toolRegistry.tools.dispatch({ id: 'foreign-workspace', name: 'get_workspace', input: { workspace_id: 2 } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('异主工作区不得读取') },
    })
    assert.equal(foreignWorkspace.kind === 'completed' && foreignWorkspace.successful, false)
    assert.match(JSON.stringify(foreignWorkspace), /工作区不存在/u)
    assert.doesNotMatch(JSON.stringify(foreignWorkspace), /他人工作区/u)
    const workspaceUpdate = await withHistory.toolRegistry.tools.dispatch({ id: 'workspace-update', name: 'update_workspace', input: { workspace_id: 1, workspace_name: '更新后的工作区', enabled: true } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('工作区修改必须经 Core 持久端口') },
    })
    assert.equal(workspaceUpdate.kind === 'completed' && workspaceUpdate.successful && workspaceUpdate.mutated, true, JSON.stringify(workspaceUpdate))
    assert.match(JSON.stringify(workspaceUpdate), /更新后的工作区/u)
    const updatedWorkspace = await withHistory.toolRegistry.tools.dispatch({ id: 'workspace-updated-read', name: 'get_workspace', input: { workspace_id: 1 } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('工作区读回必须经 Core owner-scoped 查询') },
    })
    assert.equal((updatedWorkspace.value as { name: string; enabled: boolean }).name, '更新后的工作区')
    assert.equal((updatedWorkspace.value as { name: string; enabled: boolean }).enabled, true)
    assert.equal(await runtime.db.selectFrom('workspaces').select('name').where('id', '=', 2).executeTakeFirstOrThrow().then(row => row.name), '他人工作区')
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web Run 将 owner-scoped 画布、可放置节点和笔记读取经 lease 授权接入真实 Mind 服务', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-mind-read-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const ownerId = opened.ownerId, ownerKey = ownerId.replaceAll('-', ''), otherOwner = '22222222-2222-4222-8222-222222222222'
    const timestamp = '2026-11-17T12:00:00.000001Z'
    await runtime.db.insertInto('mind_maps').values([
      { id: 1, user_id: ownerKey, title: '我的画布', project_id: null, data_json: '{"viewport":{"width":800}}', created_at: timestamp, updated_at: timestamp, deleted_at: null },
      { id: 2, user_id: otherOwner.replaceAll('-', ''), title: '他人画布隐私', project_id: null, data_json: '{}', created_at: timestamp, updated_at: timestamp, deleted_at: null },
    ]).execute()
    await sql`CREATE TABLE files (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL, ext TEXT, stage_name TEXT, updated_at TEXT, deleted_at TEXT)`.execute(runtime.db)
    await sql`INSERT INTO files (id, user_id, display_name, ext, stage_name, updated_at, deleted_at) VALUES
      (998, ${ownerKey}, '安全报告', 'md', '', ${timestamp}, NULL),
      (999, ${otherOwner.replaceAll('-', '')}, '异主文件隐私', 'md', '', ${timestamp}, NULL)`.execute(runtime.db)
    await runtime.db.insertInto('mind_nodes').values([
      { id: 11, user_id: ownerKey, kind: 'canvas_note', title: '安全画布节点', content_md: '节点正文', content_plain: '安全 画布 信息', color: 'blue', ref_type: null, ref_id: null, ref_snapshot: null, origin: 'gugu', indexed_at: null, indexed_hash: null, version: 1, captured_at: timestamp, created_at: timestamp, updated_at: timestamp, deleted_at: null },
      { id: 12, user_id: ownerKey, kind: 'canvas_note', title: '关系端点', content_md: '第二个节点', content_plain: '第二个节点', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'gugu', indexed_at: null, indexed_hash: null, version: 1, captured_at: timestamp, created_at: timestamp, updated_at: timestamp, deleted_at: null },
      { id: 13, user_id: ownerKey, kind: 'note', title: '普通安全笔记', content_md: '第一行\n[[file:999|无权引用]]', content_plain: '安全 笔记 正文', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'gugu', indexed_at: null, indexed_hash: null, version: 1, captured_at: timestamp, created_at: timestamp, updated_at: timestamp, deleted_at: null },
      { id: 14, user_id: otherOwner.replaceAll('-', ''), kind: 'note', title: '他人笔记隐私', content_md: '异主正文', content_plain: '安全 异主信息', color: null, ref_type: null, ref_id: null, ref_snapshot: null, origin: 'gugu', indexed_at: null, indexed_hash: null, version: 1, captured_at: timestamp, created_at: timestamp, updated_at: timestamp, deleted_at: null },
    ]).execute()
    await runtime.db.insertInto('mind_canvas_items').values([
      { id: 21, user_id: ownerKey, canvas_id: 1, node_id: 11, x: 10, y: 20, w: null, h: null, z: 1, collapsed: 0, data_json: '{}', created_at: timestamp, updated_at: timestamp, deleted_at: null },
      { id: 22, user_id: ownerKey, canvas_id: 1, node_id: 12, x: 300, y: 20, w: null, h: null, z: 2, collapsed: 0, data_json: '{}', created_at: timestamp, updated_at: timestamp, deleted_at: null },
      { id: 23, user_id: otherOwner.replaceAll('-', ''), canvas_id: 2, node_id: 14, x: 0, y: 0, w: null, h: null, z: 1, collapsed: 0, data_json: '{}', created_at: timestamp, updated_at: timestamp, deleted_at: null },
    ]).execute()
    await runtime.db.insertInto('mind_relations').values({ id: 31, user_id: ownerKey, canvas_id: 1, src_node_id: 11, dst_node_id: 12,
      rel_type: 'related', edge_key: '', origin: 'user', status: 'confirmed', note: null, created_at: timestamp, updated_at: timestamp, deleted_at: null }).execute()

    const identity = { ownerId, sessionId: '71', runId: 'mind-read-run' }
    const lease = { identity, token: 'mind-read-lease', fence: 9, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 1, locale: 'zh-CN' as const, origin: null, accessVersion: 'e'.repeat(64), v: 2 as const, source: 'web' as const } }
    let active = true, publications = 0
    const pool = { async query(_query: string, values: unknown[]) {
      assert.deepEqual(values, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rowCount: active ? 1 : 0, rows: [] }
    } }
    const ports = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool: pool as never, storageRoot: join(directory, 'storage'), lease,
      selection: { contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion, modelIdentity: 'synthetic-model' },
      enabled: async () => true, enabledCanvasReads: true, enabledCanvasPlaceableSearch: true, enabledCanvasCreate: true, enabledCanvasMutations: true, enabledNoteReads: true, enabledNoteLifecycle: true,
      canvases: createSqlMindCanvasReader(runtime.db, 'sqlite'), canvasPlaceableSearch: createAgentPlaceableSearch(runtime.db, 'sqlite'),
      canvasCreation: createCanvasCreationPort(runtime, async () => { publications++ }),
      ...createWebAgentCanvasMutationPorts({ core: runtime, publish: async () => { publications++ }, publishNote: async () => { publications++ } }),
      notes: createAgentMindReader(runtime.db, 'sqlite'),
    })
    const configuration = await ports.configuration(identity, new AbortController().signal)
    for (const name of ['canvas_list', 'canvas_get', 'canvas_search', 'canvas_focus_node', 'canvas_search_placeable', 'canvas_create', 'canvas_create_note', 'canvas_add_node', 'canvas_update_node', 'canvas_remove_node', 'canvas_update_note', 'canvas_update_anchor', 'canvas_connect', 'note_search', 'note_get', 'note_delete', 'note_restore', 'note_undo']) assert.ok(configuration.toolNames.includes(name))
    const definitions = await ports.toolRegistry.capabilities(identity)
    for (const name of ['canvas_list', 'canvas_get', 'canvas_search', 'canvas_focus_node', 'canvas_search_placeable', 'canvas_create', 'canvas_create_note', 'canvas_add_node', 'canvas_update_node', 'canvas_remove_node', 'canvas_update_note', 'canvas_update_anchor', 'canvas_connect', 'note_search', 'note_get', 'note_delete', 'note_restore', 'note_undo']) assert.ok(definitions.some(tool => tool.name === name))
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('Mind 只读工具不得调用执行后端') } }
    const canvases = await ports.toolRegistry.tools.dispatch({ id: 'canvas-list', name: 'canvas_list', input: { limit: 20, offset: 0 } }, scope)
    assert.equal(canvases.kind === 'completed' && canvases.successful, true, JSON.stringify(canvases))
    assert.match(JSON.stringify(canvases), /我的画布/u)
    assert.doesNotMatch(JSON.stringify(canvases), /他人画布隐私/u)
    assert.deepEqual((canvases as { value: { total: number; canvases: unknown[] } }).value.total, 1)
    const focus = await ports.toolRegistry.tools.dispatch({ id: 'canvas-focus', name: 'canvas_focus_node', input: { canvas_id: 1, item_id: 21 } }, scope)
    assert.equal(focus.kind === 'completed' && focus.successful, true, JSON.stringify(focus))
    assert.match(JSON.stringify(focus), /gugu:\/\/focus-canvas\/1\/11/u)
    const foreignFocus = await ports.toolRegistry.tools.dispatch({ id: 'foreign-focus', name: 'canvas_focus_node', input: { canvas_id: 2, item_id: 23 } }, scope)
    assert.equal(foreignFocus.kind === 'completed' && foreignFocus.successful, false)
    const placeable = await ports.toolRegistry.tools.dispatch({ id: 'placeable', name: 'canvas_search_placeable', input: { query: '安全', types: ['file'], canvas_id: 1 } }, scope)
    assert.equal(placeable.kind === 'completed' && placeable.successful, true, JSON.stringify(placeable))
    assert.match(JSON.stringify(placeable), /安全报告/u)
    assert.doesNotMatch(JSON.stringify(placeable), /异主文件隐私/u)
    assert.deepEqual((placeable as { value: { count: number; matches: unknown[] } }).value.count, 1)
    const created = await ports.toolRegistry.tools.dispatch({ id: 'canvas-create', name: 'canvas_create', input: { title: '新的工作画布' } }, scope)
    assert.equal(created.kind === 'completed' && created.successful && created.mutated, true, JSON.stringify(created))
    assert.match(JSON.stringify(created), /新的工作画布/u)
    assert.equal(publications, 1)
    assert.equal(await runtime.db.selectFrom('mind_maps').select('id').where('user_id', '=', ownerKey).where('title', '=', '新的工作画布').executeTakeFirstOrThrow().then(row => Number(row.id) > 0), true)
    const canvas = await ports.toolRegistry.tools.dispatch({ id: 'canvas', name: 'canvas_get', input: { canvas_id: 1, limit: 1, include_content: true } }, scope)
    assert.equal(canvas.kind === 'completed' && canvas.successful, true, JSON.stringify(canvas))
    assert.match(JSON.stringify(canvas), /安全画布节点/u)
    assert.doesNotMatch(JSON.stringify(canvas), /他人画布隐私|异主正文/u)
    const search = await ports.toolRegistry.tools.dispatch({ id: 'canvas-search', name: 'canvas_search', input: { canvas_id: 1, query: '安全', limit: 1 } }, scope)
    assert.equal(search.kind === 'completed' && search.successful, true, JSON.stringify(search))
    assert.match(JSON.stringify(search), /安全画布节点/u)
    const notes = await ports.toolRegistry.tools.dispatch({ id: 'note-search', name: 'note_search', input: { query: '安全', include_content: true } }, scope)
    assert.equal(notes.kind === 'completed' && notes.successful, true, JSON.stringify(notes))
    assert.match(JSON.stringify(notes), /普通安全笔记/u)
    assert.match(JSON.stringify(notes), /无权引用/u)
    assert.doesNotMatch(JSON.stringify(notes), /他人笔记隐私|异主正文|异主文件隐私/u)
    assert.deepEqual((notes as { value: { references: unknown[] } }).value.references, [])
    const note = await ports.toolRegistry.tools.dispatch({ id: 'note', name: 'note_get', input: { node_id: 13 } }, scope)
    assert.equal(note.kind === 'completed' && note.successful, true, JSON.stringify(note))
    assert.match(JSON.stringify(note), /第一行/u)
    assert.match(JSON.stringify(note), /无权引用/u)
    assert.deepEqual((note as { value: { references: unknown[] } }).value.references, [])
    const createdNote = await ports.toolRegistry.tools.dispatch({ id: 'canvas-note-create', name: 'canvas_create_note', input: { canvas_id: 1, title: '代理新便签', content: '创建后可更新' } }, scope)
    assert.equal(createdNote.kind === 'completed' && createdNote.successful && createdNote.mutated, true, JSON.stringify(createdNote))
    assert.match(JSON.stringify(createdNote), /代理新便签/u)
    const newNodeId = Number(await runtime.db.selectFrom('mind_nodes').select('id').where('user_id', '=', ownerKey).where('title', '=', '代理新便签').executeTakeFirstOrThrow().then(row => row.id))
    const newItemId = Number(await runtime.db.selectFrom('mind_canvas_items').select('id').where('user_id', '=', ownerKey).where('node_id', '=', newNodeId).executeTakeFirstOrThrow().then(row => row.id))
    const noteUpdated = await ports.toolRegistry.tools.dispatch({ id: 'canvas-note-update', name: 'canvas_update_note', input: { node_id: newNodeId, title: '代理已更新便签', content: '更新后的正文' } }, scope)
    assert.equal(noteUpdated.kind === 'completed' && noteUpdated.successful && noteUpdated.mutated, true, JSON.stringify(noteUpdated))
    assert.equal(await runtime.db.selectFrom('mind_nodes').select('title').where('id', '=', newNodeId).executeTakeFirstOrThrow().then(row => row.title), '代理已更新便签')
    const refAdded = await ports.toolRegistry.tools.dispatch({ id: 'canvas-ref-add', name: 'canvas_add_node', input: { canvas_id: 1, ref_type: 'file', ref_id: 998 } }, scope)
    assert.equal(refAdded.kind === 'completed' && refAdded.successful && refAdded.mutated, true, JSON.stringify(refAdded))
    const refNodeId = Number(await runtime.db.selectFrom('mind_nodes').select('id').where('user_id', '=', ownerKey).where('kind', '=', 'ref').where('ref_type', '=', 'file').where('ref_id', '=', 998).executeTakeFirstOrThrow().then(row => row.id))
    const connected = await ports.toolRegistry.tools.dispatch({ id: 'canvas-connect', name: 'canvas_connect', input: { canvas_id: 1, source_node_id: 11, target_node_id: 12 } }, scope)
    assert.equal(connected.kind === 'completed' && connected.successful, true, JSON.stringify(connected))
    const anchored = await ports.toolRegistry.tools.dispatch({ id: 'canvas-anchor', name: 'canvas_update_anchor', input: { canvas_id: 1, relation_id: 31, source_side: 'left', target_side: 'right' } }, scope)
    assert.equal(anchored.kind === 'completed' && anchored.successful, true, JSON.stringify(anchored))
    const addedView = await runtime.db.selectFrom('mind_canvas_items').select('id').where('user_id', '=', ownerKey).where('canvas_id', '=', 1).where('node_id', '=', refNodeId).executeTakeFirstOrThrow()
    const removed = await ports.toolRegistry.tools.dispatch({ id: 'canvas-view-remove', name: 'canvas_remove_node', input: { canvas_id: 1, item_id: Number(addedView.id) } }, scope)
    assert.equal(removed.kind === 'completed' && removed.successful && removed.mutated, true, JSON.stringify(removed))
    assert.equal(await runtime.db.selectFrom('mind_nodes').select('id').where('id', '=', refNodeId).where('deleted_at', 'is', null).executeTakeFirst().then(Boolean), true)
    const moved = await ports.toolRegistry.tools.dispatch({ id: 'canvas-node-update', name: 'canvas_update_node', input: { canvas_id: 1, item_id: 21, x: 55, y: 65 } }, scope)
    assert.equal(moved.kind === 'completed' && moved.successful && moved.mutated, true, JSON.stringify(moved))
    assert.equal(await runtime.db.selectFrom('mind_canvas_items').select('x').where('id', '=', 21).executeTakeFirstOrThrow().then(row => Number(row.x)), 55)
    const foreignMutation = await ports.toolRegistry.tools.dispatch({ id: 'foreign-canvas-mutation', name: 'canvas_update_node', input: { canvas_id: 2, item_id: 23, x: 90, y: 90 } }, scope)
    assert.equal(foreignMutation.kind === 'completed' && foreignMutation.successful, false)
    assert.equal(await runtime.db.selectFrom('mind_canvas_items').select('x').where('id', '=', 23).executeTakeFirstOrThrow().then(row => Number(row.x)), 0)
    const noteDeleted = await ports.toolRegistry.tools.dispatch({ id: 'note-delete', name: 'note_delete', input: { node_id: 13 } }, scope)
    assert.equal(noteDeleted.kind === 'completed' && noteDeleted.successful && noteDeleted.mutated, true, JSON.stringify(noteDeleted))
    const noteRestored = await ports.toolRegistry.tools.dispatch({ id: 'note-restore', name: 'note_restore', input: { node_id: 13 } }, scope)
    assert.equal(noteRestored.kind === 'completed' && noteRestored.successful && noteRestored.mutated, true, JSON.stringify(noteRestored))
    const undone = await ports.toolRegistry.tools.dispatch({ id: 'note-undo', name: 'note_undo', input: {} }, scope)
    assert.equal(undone.kind === 'completed' && undone.successful && undone.mutated, true, JSON.stringify(undone))
    assert.match(JSON.stringify(undone), /13/u)
    const foreignCanvas = await ports.toolRegistry.tools.dispatch({ id: 'foreign-canvas', name: 'canvas_get', input: { canvas_id: 2 } }, scope)
    assert.equal(foreignCanvas.kind === 'completed' && foreignCanvas.successful, false)
    const foreignNote = await ports.toolRegistry.tools.dispatch({ id: 'foreign-note', name: 'note_get', input: { node_id: 14 } }, scope)
    assert.equal(foreignNote.kind === 'completed' && foreignNote.successful, false)
    active = false
    const revoked = await ports.toolRegistry.tools.dispatch({ id: 'revoked', name: 'note_get', input: { node_id: 13 } }, scope)
    assert.equal(revoked.kind === 'completed' && revoked.successful, false)
    assert.doesNotMatch(JSON.stringify(revoked), /普通安全笔记|第一行/u)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('生产 RAG 端口将 memory 检索绑定到当前 Web lease、已配置工具和持久快照', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-run-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const databasePath = join(directory, 'core.db'), storageRoot = join(directory, 'storage')
    await initializeSqlite(databasePath)
    const opened = await openSqliteRuntime(databasePath)
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const ownerKey = ownerId.replaceAll('-', '')
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(row: Record<string, unknown>): { execute(): Promise<unknown> }
      }
    }
    const identity = { ownerId, sessionId: '31', runId: 'run-memory' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 4, locale: 'zh-CN' as const, origin: null, accessVersion: 'b'.repeat(64), v: 2 as const, source: 'web' as const } }
    await fixtureDb.insertInto('conversation_sessions').values({ id: 31, user_id: ownerKey, title: '合成会话', title_locked: 0,
      summary: '', source: 'web', chat_type: null, context_epoch: 2, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }).execute()
    await fixtureDb.insertInto('conversation_messages').values({ session_id: 31, conversation_seq: 1, role: 'user',
      content: '生产注册器会话召回', created_at: '2026-01-01T00:00:00Z' }).execute()
    const row = { active_run_id: identity.runId, context_epoch: 2, session_context: {
      rag_revision: 'snapshot-r2', snapshot_context: '本轮已经注入的记忆内容' } }
    const pool = { async query(_sql: string, values?: unknown[]) {
      assert.deepEqual(values, [ownerId, identity.sessionId, identity.runId])
      if (_sql.includes('SELECT active_run_id FROM conversation_sessions'))
        return { rows: row.active_run_id === identity.runId ? [{ active_run_id: row.active_run_id }] : [] }
      return { rows: [row] }
    } }
    const preparation = { async configuration(input: typeof identity) {
      assert.deepEqual(input, identity)
      return { identity: { ownerId, subject: { kind: 'session' as const, id: identity.sessionId }, workspaceId: null }, source: 'web', toolNames: ['search_memory', 'search_conversations', 'read_conversation'] }
    } }
    const leaseBoundPorts = createWebAgentProductionRagToolPorts({
      core: runtime,
      pool: pool as never,
      storageRoot,
      lease,
      registry: { async capabilities() { return [{ name: 'search_memory' }] as never } },
      preparation,
    })
    await assert.rejects(leaseBoundPorts.conversationSearch.recent(
      { ...identity, ownerId: randomUUID() }, 5, new AbortController().signal,
    ), /运行身份不匹配/u)
    await mkdir(join(storageRoot, ownerId, '.agent'), { recursive: true })
    await writeFile(join(storageRoot, ownerId, '.agent', 'memory_vec.json'), JSON.stringify({
      'rag:memory:profile:profile-v1:1': { t: 'synthetic:embedding-v1:2', v: [1, 0] },
    }), 'utf8')
    let embeddingCalls = 0
    const registry = createWebAgentProductionToolRegistry({ core: runtime, pool: pool as never, storageRoot, lease,
      preparation,
      conversations: { async read(candidate, sessionId, limit, signal) {
        signal.throwIfAborted()
        assert.equal(candidate.ownerId, ownerId)
        assert.equal(sessionId, 71)
        assert.equal(limit, 40)
        return { session_id: 71, title: '目标对话', source: 'web', messages: [{ role: '你', content: '合成历史正文' }] }
      } },
      embedding: {
        async resolve(owner) {
          assert.equal(owner, ownerId)
          return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1', apiKey: 'synthetic-key', dimensions: 2 }
        },
        createTransport() {
          return { async request(request, signal) {
            signal.throwIfAborted()
            assert.equal(request.url, 'https://embedding.example/v1/embeddings')
            embeddingCalls++
            return { status: 200, headers: {}, body: (async function* () {
              yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
            })(), async cancel() {} }
          } }
        },
      },
      authorize: async (input, name) => input.ownerId === ownerId && ['search_memory', 'search_conversations', 'read_conversation'].includes(name) })

    const webRunTools = createWebAgentToolPorts(lease, registry, {
      configuration: preparation.configuration,
      capabilities: {
        workspaceSupported: false,
        filterConfigured: async names => names,
        shellPolicy: async () => ({ allowed: false, needsConfirmation: false }),
        shellState: async () => null,
        appendShellProtocol: value => value,
        catalog: async () => null,
      },
      formatPrefix: () => [],
    })

    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('memory 查询不得调用执行后端') } }
    const discovered = await webRunTools.preparation.discover({
      identity: { ownerId, subject: { kind: 'session', id: identity.sessionId }, workspaceId: null },
      toolNames: ['search_conversations', 'search_memory', 'read_conversation', 'read_knowledge'],
    }, scope.signal)
    assert.deepEqual(discovered.map(tool => tool.name).sort(), ['read_conversation', 'search_conversations', 'search_memory'])
    const composed = createMcpAgentToolPorts({
      base: registry,
      async directory(owner) {
        assert.equal(owner, ownerId)
        return [{ name: 'mcp_lookup', description: '查找合成地点', description_short: '查找地点',
          input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          server_id: 'server-synthetic', server_name: '测试服务', tool_name: 'lookup' }]
      },
      runtime: { async dispatchForAgent(owner, server, name, args, signal) {
        assert.equal(owner, ownerId)
        assert.equal(server, 'server-synthetic')
        assert.equal(name, 'mcp_lookup')
        assert.deepEqual(args, { query: '杭州' })
        assert.equal(signal, scope.signal)
        return { result: '合成地点结果' }
      } },
      authorize: async () => true,
    })

    const indexDirectory = join(storageRoot, ownerId, '.agent', 'rag', 'memory')
    await mkdir(indexDirectory, { recursive: true })
    await writeFile(join(indexDirectory, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '偏好', summary: '', content: '本轮已经注入的记忆内容',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'profile:1', parent_document_id: 'memory:profile', chunk_index: 1, chunk_count: 2,
        source_type: 'memory', source_id: 'profile', title: '偏好', summary: '', content: '尚未注入的另一条记忆',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')

    const definitions = await composed.capabilities(identity)
    assert.ok(definitions.some(item => item.name === 'search_conversations'))
    assert.ok(definitions.some(item => item.name === 'mcp_lookup'))
    const conversationResult = await webRunTools.tools.dispatch({ id: 'conversation-run', name: 'search_conversations', input: { query: '会话召回' } }, scope)
    assert.equal(conversationResult.kind === 'completed' && conversationResult.successful, true, JSON.stringify(conversationResult))
    assert.match(JSON.stringify(conversationResult), /生产注册器会话召回/u)
    const historyResult = await webRunTools.tools.dispatch({ id: 'history-run', name: 'read_conversation', input: { session_id: 71 } }, scope)
    assert.equal(historyResult.kind === 'completed' && historyResult.successful, true, JSON.stringify(historyResult))
    assert.match(JSON.stringify(historyResult), /合成历史正文/u)
    const mcpResult = await composed.tools.dispatch({ id: 'mcp-run', name: 'mcp_lookup', input: { query: '杭州' } }, scope)
    assert.deepEqual(mcpResult, { kind: 'completed', value: { result: '合成地点结果' }, successful: true, mutated: true, executed: true })
    const result = await registry.tools.dispatch({ id: 'memory-run', name: 'search_memory', input: { query: '记忆' } }, scope)
    assert.equal(result.kind === 'completed' && result.successful, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /尚未注入的另一条记忆/u)
    assert.doesNotMatch(JSON.stringify(result), /本轮已经注入的记忆内容/u)
    assert.equal(result.kind === 'completed' ? (result.value as { strategy: string }).strategy : '', 'hybrid')
    assert.equal(embeddingCalls, 1)

    row.active_run_id = 'superseded-run'
    const stale = await registry.tools.dispatch({ id: 'memory-stale', name: 'search_memory', input: { query: '记忆' } }, scope)
    assert.equal(stale.kind === 'completed' && stale.successful, false)

    row.active_run_id = identity.runId
    const noLongerConfigured = { ...preparation, async configuration(input: typeof identity) {
      const current = await preparation.configuration(input)
      return { ...current, toolNames: [] }
    } }
    const deniedRegistry = createWebAgentProductionToolRegistry({ core: runtime, pool: pool as never, storageRoot, lease,
      preparation: noLongerConfigured, authorize: async () => true })
    const deniedResult = await deniedRegistry.tools.dispatch({ id: 'memory-disabled', name: 'search_memory', input: { query: '记忆' } }, scope)
    assert.equal(deniedResult.kind === 'completed' && deniedResult.successful, false)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web 自动 RAG 从正式索引召回 owner 内容并排除历史已注入正文', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-context-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const ownerId = opened.ownerId
    const identity = { ownerId, sessionId: '81', runId: 'rag-context-run' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 5, locale: 'zh-CN' as const, origin: null, accessVersion: 'c'.repeat(64), v: 2 as const, source: 'web' as const } }
    const writer = createSqlRagPersistentIndexWriter(runtime.db, runtime.backend)
    await writer.replaceSource(ownerId, 'memory', [{
      id: 'memory:deployment:0', source_id: 'deployment', source_type: 'memory',
      scope_type: 'owner', scope_id: '', title: '部署复盘', summary: '版本上线检查',
      content: '发布前先完成部署回归和 owner 隔离检查。', text: '部署复盘\n发布前先完成部署回归和 owner 隔离检查。',
      parent_id: 'memory:deployment', document_version: 'v1', chunk_index: 0, chunk_count: 1,
      metadata: {},
    }])
    let authorized = 0
    const build = createWebAgentRagContextBuilder({
      core: runtime,
      lease,
      enabled: async () => true,
      async authorize(bound, scope) {
        authorized++
        return bound.identity.ownerId === ownerId && scope.scope_type === 'owner' && scope.scope_id === ''
      },
    })
    const input = {
      ownerId, sessionId: identity.sessionId, history: [], fixedPrefix: [], snapshotText: '',
      currentUser: { persistedMessageId: '5', rawText: '部署回归', message: { role: 'user' as const, content: '部署回归' } },
    }
    const preparation = { digest: () => 'digest', nextId: () => 'id', buildRag: build }
    const first = await buildRunRagContext(input, preparation, new AbortController().signal)
    assert.equal(first.injected, true)
    assert.match(JSON.stringify(first.tail), /发布前先完成部署回归/u)
    assert.equal(authorized, 3)
    await assert.rejects(buildRunRagContext({ ...input, ownerId: randomUUID() }, preparation, new AbortController().signal), /运行身份不匹配/u)
    await assert.rejects(buildRunRagContext({ ...input, sessionId: '82' }, preparation, new AbortController().signal), /运行身份不匹配/u)

    await mkdir(join(directory, 'rag-storage', ownerId, '.agent'), { recursive: true })
    await writeFile(join(directory, 'rag-storage', ownerId, '.agent', 'memory_vec.json'), JSON.stringify({
      'rag:memory:deployment:v1:0': { t: 'synthetic:embedding-v1:2', v: [1, 0] },
    }), 'utf8')
    let embeddingCalls = 0, activeScopeChecks = 0, leaseActive = true
    const activePool = { async query(_sql: string, values?: unknown[]) {
      activeScopeChecks++
      assert.deepEqual(values, [ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rowCount: leaseActive ? 1 : 0, rows: leaseActive ? [{}] : [] }
    } }
    const productionBuild = createWebAgentProductionRagContextBuilder({
      core: runtime,
      pool: activePool as never,
      storageRoot: join(directory, 'rag-storage'),
      lease,
      selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: true } },
      enabled: () => true,
      embedding: {
        async resolve(boundOwner) {
          assert.equal(boundOwner, ownerId)
          return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1', apiKey: 'test-only', dimensions: 2 }
        },
        createTransport() {
          return { async request(_request, signal) {
            signal.throwIfAborted()
            embeddingCalls++
            return { status: 200, headers: {}, body: (async function* () {
              yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
            })(), async cancel() {} }
          } }
        },
      },
    })
    const vectorResult = await buildRunRagContext(input, { ...preparation, buildRag: productionBuild }, new AbortController().signal)
    assert.equal(vectorResult.injected, true)
    assert.match(JSON.stringify(vectorResult.tail), /发布前先完成部署回归/u)
    assert.equal(embeddingCalls, 1)
    assert.ok(activeScopeChecks > 0)

    const memoryContextDisabledBuild = createWebAgentProductionRagContextBuilder({
      core: runtime, pool: activePool as never, storageRoot: join(directory, 'rag-storage'), lease,
      selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: false } }, enabled: () => true,
    })
    const memoryContextDisabled = await buildRunRagContext(input, { ...preparation, buildRag: memoryContextDisabledBuild }, new AbortController().signal)
    assert.equal(memoryContextDisabled.injected, true)

    leaseActive = false
    const expiredLeaseResult = await buildRunRagContext(input, { ...preparation, buildRag: productionBuild }, new AbortController().signal)
    assert.equal(expiredLeaseResult.injected, false)
    assert.equal(expiredLeaseResult.reason, 'no_eligible_scope')

    const block = (first.tail[0]!.content as import('@gugu/core/agent').Json[])[0]!
    const second = await buildRunRagContext({ ...input, history: [{
      ownerId, sessionId: identity.sessionId, id: '3', conversationSeq: 3, role: 'user', content: [],
      contentJson: [block],
    }] }, preparation, new AbortController().signal)
    assert.equal(second.injected, false)
    assert.deepEqual(second.tail, [])

    const denied = createWebAgentRagContextBuilder({ core: runtime, lease, enabled: () => true, async authorize() { return false } })
    assert.equal((await buildRunRagContext(input, { ...preparation, buildRag: denied }, new AbortController().signal)).reason, 'no_eligible_scope')

    const disabled = createWebAgentRagContextBuilder({ core: runtime, lease, enabled: () => false, async authorize() { assert.fail('关闭 RAG 后不得检查索引授权') } })
    assert.equal((await buildRunRagContext(input, { ...preparation, buildRag: disabled }, new AbortController().signal)).reason, 'disabled')

    let authorizeStarted!: () => void
    let resumeAuthorization!: () => void
    const authorizationStarted = new Promise<void>(resolve => { authorizeStarted = resolve })
    const authorizationGate = new Promise<void>(resolve => { resumeAuthorization = resolve })
    const cancellable = createWebAgentRagContextBuilder({
      core: runtime, lease, enabled: () => true,
      async authorize() {
        authorizeStarted()
        await authorizationGate
        return true
      },
    })
    const controller = new AbortController()
    const pending = buildRunRagContext(input, { ...preparation, buildRag: cancellable }, controller.signal)
    await authorizationStarted
    controller.abort()
    resumeAuthorization()
    await assert.rejects(pending, { name: 'AbortError' })
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('生产 Web RAG 在选中模型或 scope 版本不匹配时不创建授权端口', () => {
  const identity = { ownerId: 'owner-a', sessionId: '7', runId: 'scope-mismatch' }
  const lease = { identity, token: 'lease', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { userMessageId: 11, locale: 'zh-CN' as const, origin: null, accessVersion: 'a'.repeat(64), v: 2 as const, source: 'web' as const } }
  let queries = 0
  const pool = { async query() { queries++; return { rows: [], rowCount: 0 } } }
  const selection = { modelIdentity: 'synthetic-model', contextScopeKey: 'b'.repeat(64),
    contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
  assert.throws(() => createAuthorizedWebAgentProductionRagRunPorts({ core: {} as never, pool: pool as never,
    storageRoot: '/synthetic-root', lease, selection, enabled: () => true }), /配置版本与调度授权不匹配/u)
  assert.equal(queries, 0)
  assert.throws(() => createAuthorizedWebAgentProductionRagRunPorts({ core: {} as never, pool: pool as never,
    storageRoot: '/synthetic-root', lease, selection: { ...selection, contextScopeKey: lease.input.accessVersion, modelIdentity: '' }, enabled: () => true }), /配置版本与调度授权不匹配/u)
  assert.equal(queries, 0)
})

test('生产 Run RAG 组合让自动注入与检索工具共享 lease 和可信配置', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-run-ports-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const ownerId = opened.ownerId, identity = { ownerId, sessionId: '91', runId: 'shared-rag-run' }
    const lease = { identity, token: 'synthetic-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 6, locale: 'zh-CN' as const, origin: null, accessVersion: 'd'.repeat(64), v: 2 as const, source: 'web' as const } }
    const fixtureDb = runtime.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(row: Record<string, unknown>): { execute(): Promise<unknown> }
      }
    }
    await fixtureDb.insertInto('conversation_sessions').values({ id: 91, user_id: ownerId.replaceAll('-', ''), title: '共享 RAG', title_locked: 0,
      summary: '', source: 'web', chat_type: null, context_epoch: 3, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }).execute()
    await fixtureDb.insertInto('conversation_messages').values({ session_id: 91, conversation_seq: 1, role: 'user',
      content: '共享 lease 会话检索', created_at: '2026-01-01T00:00:00Z' }).execute()
    const writer = createSqlRagPersistentIndexWriter(runtime.db, runtime.backend)
    await writer.replaceSource(ownerId, 'memory', [{ id: 'memory:profile:0', source_id: 'profile', source_type: 'memory',
      scope_type: 'owner', scope_id: '', title: '共享运行', summary: '', content: '共享授权记忆内容', text: '共享授权记忆内容',
      parent_id: 'memory:profile', document_version: 'profile-v1', chunk_index: 0, chunk_count: 1, metadata: {} }])
    const ownerIndex = join(directory, ownerId, '.agent', 'rag', 'memory')
    await mkdir(ownerIndex, { recursive: true })
    await writeFile(join(ownerIndex, 'index.json'), JSON.stringify({ schema_version: 1, documents: [
      { document_id: 'profile:0', parent_document_id: 'memory:profile', chunk_index: 0, chunk_count: 1,
        source_type: 'memory', source_id: 'profile', title: '共享运行', summary: '', content: '共享授权记忆内容',
        version: 'profile-v1', scope: { owner_user_id: ownerId, scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }), 'utf8')
    let active = true
    const pool = { async query(sql: string) {
      if (!active) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT active_run_id,context_epoch,session_context'))
        return { rows: [{ active_run_id: identity.runId, context_epoch: 3, session_context: { rag_revision: 'r3', snapshot_context: '' } }], rowCount: 1 }
      if (sql.includes('SELECT active_run_id FROM conversation_sessions'))
        return { rows: [{ active_run_id: identity.runId }], rowCount: 1 }
      return { rows: [{}], rowCount: 1 }
    } }
    const ports = createAuthorizedWebAgentProductionRagRunPorts({ core: runtime, pool: pool as never, storageRoot: directory,
      lease, selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }, enabled: () => true })
    const definitions = await ports.toolRegistry.capabilities(identity)
    assert.ok(definitions.some(item => item.name === 'search_conversations'))
    assert.ok(definitions.some(item => item.name === 'search_memory'))
    const restricted = createAuthorizedWebAgentProductionRagRunPorts({ core: runtime, pool: pool as never, storageRoot: directory,
      lease, selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: false, memoryEnabled: true } }, enabled: () => true })
    assert.deepEqual((await restricted.configuration(identity, new AbortController().signal)).toolNames, [])
    assert.deepEqual(await restricted.toolRegistry.capabilities(identity), [])
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('RAG 只读调用不能请求进程执行') } }
    const result = await ports.toolRegistry.tools.dispatch({ id: 'search-memory', name: 'search_memory', input: { query: '授权记忆' } }, scope)
    assert.equal(result.kind === 'completed' && result.successful, true, JSON.stringify(result))
    assert.match(JSON.stringify(result), /共享授权记忆内容/u)
    const automatic = await buildRunRagContext({ ownerId, sessionId: identity.sessionId, history: [], fixedPrefix: [], snapshotText: '',
      currentUser: { persistedMessageId: '6', rawText: '授权记忆', message: { role: 'user', content: '授权记忆' } } },
    { digest: () => 'digest', nextId: () => 'id', buildRag: ports.ragContext }, new AbortController().signal)
    assert.equal(automatic.injected, true)
    assert.match(JSON.stringify(automatic.tail), /共享授权记忆内容/u)
    active = false
    const stale = await ports.toolRegistry.tools.dispatch({ id: 'stale-memory', name: 'search_memory', input: { query: '授权记忆' } }, scope)
    assert.equal(stale.kind === 'completed' && stale.successful, false)
    const staleAutomatic = await buildRunRagContext({ ownerId, sessionId: identity.sessionId, history: [], fixedPrefix: [], snapshotText: '',
      currentUser: { persistedMessageId: '6', rawText: '授权记忆', message: { role: 'user', content: '授权记忆' } } },
    { digest: () => 'digest', nextId: () => 'id', buildRag: ports.ragContext }, new AbortController().signal)
    assert.equal(staleAutomatic.injected, false)
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('delete_client 经生产 Web lease registry 确认后删除，撤权后拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-agent-client-delete-'))
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    runtime = opened.runtime
    const identity = { ownerId: opened.ownerId, sessionId: '92', runId: 'client-delete-run' }
    const lease = { identity, token: 'client-delete-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 7, locale: 'zh-CN' as const, origin: null, accessVersion: 'e'.repeat(64), v: 2 as const, source: 'web' as const } }
    let active = true
    const pool = { async query(_sql: string, values: unknown[]) {
      assert.deepEqual(values, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
      return { rows: [], rowCount: active ? 1 : 0 }
    } }
    let inputDigest: string | null = null
    let targetSnapshot: unknown
    let claims = 0
    const gate = {
      async prepare(toolCall: unknown, _scope: unknown, digest: string, targets: unknown) {
        inputDigest = digest; targetSnapshot = structuredClone(targets)
        return { ok: true as const, value: { id: 'delete-client-confirmation', kind: 'confirmation' as const, toolCall } }
      },
      async verify(_toolCall: unknown, _scope: unknown, digest: string, targets: unknown) {
        return inputDigest === digest && JSON.stringify(targetSnapshot) === JSON.stringify(targets)
          ? { ok: true as const, value: { intentId: 'client-delete-intent', operationId: 'client-delete-operation' } }
          : { ok: false as const, code: 'confirmation_rejected' as const }
      },
    } as unknown as ClientDeleteConfirmationPort['gate']
    const ports = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool: pool as never, storageRoot: directory, lease,
      selection: { modelIdentity: 'synthetic-model', contextScopeKey: lease.input.accessVersion,
        contextPolicy: { loadOwnerContext: true, memoryEnabled: true } },
      enabled: async () => true,
      enabledClientTools: true,
      enabledClientDelete: true,
      clientDelete: createClientDeletePort(runtime, { gate, async claim() { claims++; return true } }),
    })
    const create = await ports.toolRegistry.tools.dispatch({ id: 'seed-client', name: 'create_client', input: { client_name: '要删除的联系人' } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('联系人工具不得调用进程执行器') },
    })
    assert.equal(create.kind === 'completed' && create.successful, true, JSON.stringify(create))
    const capabilities = await ports.toolRegistry.capabilities(identity)
    assert.ok(capabilities.some(item => item.name === 'delete_client'))
    const call = { id: 'delete-client', name: 'delete_client', input: { client: '要删除的联系人' } }
    const waiting = await ports.toolRegistry.tools.dispatch(call, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('联系人删除必须经过确认') },
    })
    assert.equal(waiting.kind, 'waiting')
    const confirmed = await ports.toolRegistry.tools.dispatch(call, {
      identity, roundId: '1', signal: new AbortController().signal,
      resolution: { interactionId: 'delete-client-confirmation', receiptId: 'trusted-delete-receipt', status: 'confirmed', value: {} },
      execute: async () => { throw new Error('联系人删除必须经过确认') },
    })
    assert.deepEqual(confirmed, { kind: 'completed', successful: true, mutated: true,
      value: { success: true, deleted_client_id: 1, name: '要删除的联系人' } })
    assert.equal(claims, 1)
    assert.deepEqual(await runtime.transaction({ ownerId: identity.ownerId } as never, data => data.clients.list()), [])

    const second = await ports.toolRegistry.tools.dispatch({ id: 'seed-again', name: 'create_client', input: { client_name: 'lease撤销后保留' } }, {
      identity, roundId: '2', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('联系人工具不得调用进程执行器') },
    })
    assert.equal(second.kind === 'completed' && second.successful, true)
    active = false
    const revoked = await ports.toolRegistry.tools.dispatch({ id: 'revoked-delete-client', name: 'delete_client', input: { client_id: 2 } }, {
      identity, roundId: '2', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('撤销的租约不得删除联系人') },
    })
    assert.equal(revoked.kind === 'completed' && revoked.successful, false)
    const retained = await runtime.transaction({ ownerId: identity.ownerId }, data => data.clients.list())
    assert.equal(retained.length, 1)
    assert.equal(retained[0]?.name, 'lease撤销后保留')
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web Run 仅公布已装配的新工具并在配置与执行授权中复验租约', async () => {
  const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '9', runId: 'run-capabilities' }
  const lease = { identity, token: 'synthetic', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) } }
  let active = true
  const pool = { async query(_query: string, values: unknown[]) {
    assert.deepEqual(values, [identity.ownerId, identity.sessionId, identity.runId, lease.token, lease.fence])
    return { rowCount: active ? 1 : 0 }
  } } as never
  const options = {
    pool, lease, core: {} as never, storageRoot: '/synthetic',
    selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
    enabled: () => false,
  }
  const selected = ['call_tool', 'create_skill', 'update_skill', 'delete_skill', 'note_create', 'note_update',
    'delete_scheduled_task', 'manage_mcp_servers', 'web_search', 'similar_image_search', 'deep_research']
  const onlySelected = (names: readonly string[]) => selected.filter(name => names.includes(name))
  const signal = new AbortController().signal
  const missing = createAuthorizedWebAgentProductionRagRunPorts(options)
  assert.deepEqual(onlySelected((await missing.configuration(identity, signal)).toolNames), [])
  const tool = (name: string) => ({
    definition: { name, schema: { type: 'function', function: { name, parameters: { type: 'object' } } } },
    effect: 'read' as const,
    validate: () => ({ success: true as const, data: {} }),
    async execute() { return { kind: 'completed' as const, successful: true, mutated: false, value: { name } } },
  })
  const equipped = createAuthorizedWebAgentProductionRagRunPorts({
    ...options, callTool: true, noteWrites: {} as never, skillManagement: [tool('create_skill'), tool('update_skill')],
    webSearch: tool('web_search'), similarImageSearch: tool('similar_image_search'), deepResearch: tool('deep_research'),
    mcpManagement: tool('manage_mcp_servers'), skillDelete: tool('delete_skill'),
    scheduledTaskDelete: tool('delete_scheduled_task'),
  })
  assert.deepEqual(onlySelected((await equipped.configuration(identity, signal)).toolNames), selected)
  assert.deepEqual(onlySelected((await equipped.toolRegistry.capabilities(identity)).map(def => def.name)), selected)
  const scope = { identity, roundId: '1', signal, resolution: null, async execute(): Promise<never> { throw new Error('不执行进程') } }
  const call = { id: 'manage-mcp', name: 'manage_mcp_servers', input: { action: 'list' } }
  assert.equal((await equipped.toolRegistry.tools.dispatch(call, scope)).kind, 'completed')
  active = false
  const denied = await equipped.toolRegistry.tools.dispatch(call, scope)
  assert.equal(denied.kind === 'completed' && denied.successful, false)
})
