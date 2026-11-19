import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { stableJson, type ContextSourceSelection, type RunIdentity } from '@gugu/core/agent'
import { createSkillMetadataReader, createSkillRegistry } from '@gugu/core/skills'
import { createWebAgentRagResources } from '../../src/modules/agent/run/reconstruct.js'
import { createWebOwnerAgentKnowledgeReadPort } from '../../src/modules/agent/tools/knowledge/list.js'
import { createLocalAgentKnowledgeWritePort } from '../../src/modules/agent/tools/knowledge/write.js'
import { createLocalAgentKnowledgeReadStore } from '../../src/modules/agent/rag/knowledge.js'
import { createSqlRagPersistentIndexWriter } from '../../../../packages/core/src/agent/rag/persistent-writer.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

test('Web RAG resource factory 将 search_conversations 与 owner read_knowledge 接入实际注册器 dispatch', {
  skip: process.platform !== 'linux' && '生产知识写入适配器要求 Linux 安全原子写入',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-web-rag-resources-'))
  let core: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    core = opened.runtime
    const ownerId = opened.ownerId
    const knowledgeRoot = join(directory, ownerId, '.agent', 'knowledge')
    await mkdir(join(knowledgeRoot, 'entries'), { recursive: true })
    await writeFile(join(knowledgeRoot, '.timestamps-iso-v1'), '')
    await writeFile(join(knowledgeRoot, 'entries', 'k-web.md'), `---\nid: k-web\ntitle: 合成知识\ntopic: 发布\ndescription: owner 私有正文\nkeywords_json: ["发布"]\nconfidence: confirmed\nsource_json: {"type":"user"}\nscope_json: {"type":"owner", "owner_user_id":"${ownerId}"}\nversion: 1\nactive: true\ncreated_at: 2026-01-01T00:00:00+00:00\nupdated_at: 2026-01-02T00:00:00+00:00\n---\n只允许当前 owner 读取`)
    await mkdir(join(directory, ownerId, '.agent'), { recursive: true })
    await writeFile(join(directory, ownerId, '.agent', 'pattern.json'), JSON.stringify(Array.from({ length: 51 }, (_, index) => ({
      id: `pattern-${index}`, text: `合成偏好 ${index}`, kind: 'observed', conf: 0.9, imp: 3, ts: 1_767_225_600,
    }))))
    await writeFile(join(directory, ownerId, '.agent', 'pattern_vec.json'), JSON.stringify({
      'pattern-50': { t: 'synthetic:embedding-v1:2', v: [0, 1] },
      ...Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`pattern-${index}`, { t: 'synthetic:embedding-v1:2', v: [1, 0] }])),
    }))
    const lease = {
      identity: { ownerId, sessionId: '71', runId: 'rag-resource-run' },
      token: 'synthetic-lease-token', fence: 3, mode: 'start' as const, cancelRequested: false,
      input: { v: 2 as const, source: 'web' as const, userMessageId: 901, locale: 'zh-CN' as const,
        origin: null, accessVersion: 'a'.repeat(64) },
    }
    let queryCalls = 0
    const pool = {
      async query(statement: string) {
        queryCalls++
        return { rowCount: 1, rows: statement.includes('SELECT u.timezone')
          ? [{ timezone: 'Asia/Shanghai', data_json: null }]
          : [{}] }
      },
    }
    const embeddingOwners: string[] = []
    let knowledgePort: ReturnType<typeof createWebOwnerAgentKnowledgeReadPort> | undefined
    const resourcesForLease = createWebAgentRagResources({
      compactionInstruction: '将较早的历史整理为状态摘要。',
      source: {
        pool: pool as never,
        files: { async read() { return null } },
        memoryStorageRoot: directory,
        redis: { async get() { return null } },
        serverTimezone: 'UTC',
        now: () => Date.UTC(2026, 0, 1),
        external: {
          async loadImChannels() { return {} },
          async loadImMemory() { return {} },
          async loadKnowledge() { return [] },
        },
        builder: {
          now: () => Date.UTC(2026, 0, 1),
          staticPrompt: () => ({ base: '系统提示', persona: '', skills: '', policy: '', retrieval: '', skillIndex: '', timezone: 'UTC', now: new Date(0) }),
          sessionInfo: () => ({}),
          systemInMessages: () => false,
        },
      },
      rag: {
        core, pool: pool as never, storageRoot: directory, enabled: () => true,
        async toolPorts(lease, _binding, context) {
          assert.equal(lease.identity.ownerId, ownerId)
          const store = createLocalAgentKnowledgeReadStore(directory)
          knowledgePort = createWebOwnerAgentKnowledgeReadPort(core!, store, {
            timezone: (identity, signal) => context.loadTimezone(identity, signal),
          })
          return {
            skills: {
              skills: createSkillRegistry({
                skills: [{ id: 'S1', name: '合成技能', description: '只用于验证按需加载。', async load() { return { content: '合成技能正文', contentDigest: 'synthetic-digest' } } }],
                async authorize(identity) { return identity.ownerId === ownerId },
              }),
              async origin(identity) { if (identity.ownerId !== ownerId) throw new Error('技能来源无效'); return { source: 'builtin' as const } },
            },
            skillMetadata: createSkillMetadataReader(core!.db, 'sqlite', []),
            knowledge: knowledgePort,
            knowledgeWrites: createLocalAgentKnowledgeWritePort(core!, directory, store),
            calendarCreate: {} as never,
            calendarUpdate: {} as never,
          }
        },
        embedding: {
          async resolve(owner) {
            embeddingOwners.push(owner)
            return { provider: 'synthetic', baseUrl: 'https://embedding.example/v1', model: 'embedding-v1', apiKey: 'mock-only', dimensions: 2 }
          },
          createTransport() {
            return { async request(_request, signal) {
              signal.throwIfAborted()
              return { status: 200, headers: {}, body: (async function* () {
                yield new TextEncoder().encode(JSON.stringify({ data: [{ embedding: [0, 1] }] }))
              })(), async cancel() {} }
            } }
          },
        },
      },
      remaining: {
        context: {
          digest, nextId: randomUUID,
          finalization: { async complete() {} },
          references: { async dehydrate(entry: { message: never }) { return entry.message }, async hydrate(entry: { message: never }) { return entry.message } },
          preparation: { async buildRag() { return { tail: [] } } },
          async prepareRequest() { return { prefix: [], dynamicTail: [] } },
          compaction: { async summarize() { return 'summary' } },
          currentRequest() { return null },
          async stageContinuation() { return 'continuation-ref' },
          async releaseContinuations() {},
          diagnoseCompactionFailure() {},
        },
        preparation: {
          capabilities: {
            workspaceSupported: false,
            async filterConfigured(names: readonly string[]) { return names.filter(name => ['search_conversations', 'search_memory', 'use_skill', 'list_skills', 'save_knowledge', 'update_knowledge'].includes(name)) },
            async shellPolicy() { return { allowed: false, needsConfirmation: false } },
            async shellState() { return null },
            appendShellProtocol(system: string) { return system },
            async catalog() { return null },
          },
          formatPrefix() { return [] },
        },
        materialize: async (_identity: RunIdentity, message: { id: string; content: string }) => ({
          currentUser: { persistedMessageId: message.id, message: { role: 'user', content: message.content } },
        }),
        runtime: {
          clock: { now: () => new Date(0).toISOString() },
          interactions: { async activate(_identity: RunIdentity, value: unknown) { return value } },
          sanitizeText: (value: string) => value,
          createStreamSanitizer: () => ({ push: (value: string) => value, finish: () => '' }),
          presentError: () => ({ code: 'failed', text: '运行失败' }),
          async presentToolResult(value: unknown) { return value },
          async publish() {},
          diagnose() {},
        },
        executor: {
          async authorize() { throw new Error('只读 RAG 工具不得调用执行后端') },
          executor: { async execute() { throw new Error('只读 RAG 工具不得调用执行后端') } },
        },
        provider: { transport: { async request() { throw new Error('本测试不调用 Provider') } } },
      } as never,
    })
    const selection: ContextSourceSelection = {
      modelIdentity: 'synthetic-model', contextWindow: 10000, locale: 'zh-CN', groupChat: false,
      workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion,
    }
    const binding = {
      selection,
      async resolve() { throw new Error('本测试不调用 Provider binding') },
      usageConfig: { defaultLimit6h: null, byokEnabled: false, localDeployment: false, model: 'synthetic', provider: 'openai', isByok: false },
      release() {},
    }
    const resources = await resourcesForLease(lease, binding as never)
    await resources.bindProvider?.({
      branchProvider() { return {} as never },
      async summaryProjection() { throw new Error('无效压缩预算不得创建投影') },
    } as never, {
      systemPrompt: '可信系统提示', accessScopeHash: 'synthetic-scope', config: { max_tokens: 0 },
    } as never)
    assert.equal(queryCalls, 0, '重建阶段绑定 Provider 不得在 Harness 激活 dispatch lease 前访问 RAG 授权')
    const identity = lease.identity
    const definitions = await resources.preparation.configuration(identity, new AbortController().signal)
    assert.deepEqual(definitions.toolNames, ['search_conversations', 'search_memory', 'use_skill', 'list_skills', 'list_clients', 'list_projects', 'get_tool_schema', 'read_knowledge', 'save_knowledge', 'update_knowledge', 'create_client', 'update_client', 'create_event', 'update_event'])
    const visibleTools = await resources.toolRegistry.capabilities(identity)
    assert.deepEqual(visibleTools.map(tool => tool.name).sort(), ['create_client', 'create_event', 'get_tool_schema', 'list_clients', 'list_projects', 'list_skills', 'read_knowledge', 'save_knowledge', 'search_conversations', 'search_memory', 'update_client', 'update_event', 'update_knowledge', 'use_skill'])
    const skillResult = await resources.toolRegistry.tools.dispatch({ id: 'load-skill', name: 'use_skill', input: { id: 'S1' } }, {
      identity, roundId: '1', signal: new AbortController().signal, loadedSkills: {}, resolution: null,
      execute: async () => { throw new Error('Skill 加载不能执行宿主命令') },
    } as never)
    assert.equal(skillResult.kind, 'completed')
    if (skillResult.kind === 'completed') assert.equal((skillResult.value as { content: string }).content, '合成技能正文')
    const skillList = await resources.toolRegistry.tools.dispatch({ id: 'list-skills', name: 'list_skills', input: {} }, {
      identity, roundId: '1', signal: new AbortController().signal, loadedSkills: {}, resolution: null,
      execute: async () => { throw new Error('Skill 目录读取不能执行宿主命令') },
    } as never)
    assert.equal(skillList.kind, 'completed')
    const memory = await resources.source.data.loadMemory(identity, new AbortController().signal, '历史偏好')
    assert.deepEqual(embeddingOwners, [ownerId])
    assert.match(JSON.stringify(memory), /合成偏好 50/u)

    const fixture = core.db as unknown as {
      insertInto(table: 'conversation_sessions' | 'conversation_messages'): {
        values(row: Record<string, unknown>): { execute(): Promise<unknown> }
      }
    }
    await fixture.insertInto('conversation_sessions').values({
      id: 71, user_id: ownerId.replaceAll('-', ''), title: '合成历史记录', title_locked: 0, summary: 'RAG 调用验证',
      source: 'web', chat_type: null, context_epoch: 0, baseline_message_seq: 0,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    }).execute()
    await fixture.insertInto('conversation_messages').values({
      session_id: 71, conversation_seq: 1, role: 'user', content: '验证生产 RAG 工具调用边界。', created_at: '2026-01-01T00:00:00Z',
    }).execute()
    const result = await resources.toolRegistry.tools.dispatch({ id: 'rag-call', name: 'search_conversations', input: { query: '生产 RAG' } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('只读 RAG 工具不得调用执行后端') },
    })
    assert.equal(result.kind, 'completed')
    assert.equal(result.kind === 'completed' && result.successful, true)
    assert.match(JSON.stringify(result), /合成历史记录/)
    assert.equal((await knowledgePort!.read(identity, 'k-web', new AbortController().signal))?.content, '只允许当前 owner 读取')
    const knowledge = await resources.toolRegistry.tools.dispatch({ id: 'knowledge-read', name: 'read_knowledge', input: { knowledge_id: 'k-web' } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('只读知识工具不得调用执行后端') },
    })
    assert.equal(knowledge.kind === 'completed' && knowledge.successful, true, JSON.stringify(knowledge))
    assert.match(JSON.stringify(knowledge), /只允许当前 owner 读取/u)

    const saved = await resources.toolRegistry.tools.dispatch({ id: 'knowledge-save', name: 'save_knowledge', input: {
      title: 'Run 写入知识', content: '由注册器真实调用写入 owner 文件。', topic: 'RAG', keywords: ['生产', 'RAG'],
    } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('知识写工具不得调用宿主执行后端') },
    })
    assert.equal(saved.kind === 'completed' && saved.successful, true, JSON.stringify(saved))
    const savedId = saved.kind === 'completed' ? (saved.value as { id: string }).id : ''
    assert.match(savedId, /^[a-f0-9]{32}$/u)
    assert.equal((await knowledgePort!.read(identity, savedId, new AbortController().signal))?.content, '由注册器真实调用写入 owner 文件。')

    const updated = await resources.toolRegistry.tools.dispatch({ id: 'knowledge-update', name: 'update_knowledge', input: {
      knowledge_id: savedId, content: '由 Run 更新并持久化。',
    } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('知识写工具不得调用宿主执行后端') },
    })
    assert.equal(updated.kind === 'completed' && updated.successful, true, JSON.stringify(updated))
    assert.equal((await knowledgePort!.read(identity, savedId, new AbortController().signal))?.content, '由 Run 更新并持久化。')

    const callsBeforeCompaction = queryCalls
    const summary = await resources.context.compaction.summarize({ messages: [], context: {} } as never)
    assert.equal(summary, '')
    assert.equal(queryCalls, callsBeforeCompaction, '无效压缩预算应沿用本地回退，不再查询工具配置或授权')

    const resourcesWithValidBudget = await resourcesForLease(lease, binding as never)
    await resourcesWithValidBudget.bindProvider?.({
      branchProvider() { return {} as never },
      async summaryProjection() { throw new Error('达到真实 Provider 投影边界') },
    } as never, {
      systemPrompt: '可信系统提示', accessScopeHash: 'synthetic-scope', config: { max_tokens: 256 },
    } as never)
    const callsBeforeValidCompaction = queryCalls
    await assert.rejects(resourcesWithValidBudget.context.compaction.summarize({ messages: [], context: {} } as never), /达到真实 Provider 投影边界/u)
    assert.ok(queryCalls > callsBeforeValidCompaction, '有效预算压缩在 Run 执行期读取当次工具配置与授权')
  } finally {
    await core?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('Web RAG resource factory formats conversation citations with the trusted owner timezone', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-web-rag-time-'))
  let core: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(join(directory, 'core.db'))
    const opened = await openSqliteRuntime(join(directory, 'core.db'))
    core = opened.runtime
    const ownerId = opened.ownerId
    const lease = {
      identity: { ownerId, sessionId: '91', runId: 'rag-time-run' },
      token: 'synthetic-lease-token', fence: 3, mode: 'start' as const, cancelRequested: false,
      input: { v: 2 as const, source: 'web' as const, userMessageId: 901, locale: 'zh-CN' as const,
        origin: null, accessVersion: 'a'.repeat(64) },
    }
    const pool = {
      async query(statement: string) {
        if (statement.includes('SELECT u.timezone')) return { rowCount: 1, rows: [{ timezone: 'Asia/Shanghai', data_json: null }] }
        return { rowCount: 1, rows: [{}] }
      },
    }
    await createSqlRagPersistentIndexWriter(core.db, core.backend).replaceSource(ownerId, 'conversation', [{
      id: 'conversation:902:0', source_id: '902', source_type: 'conversation', scope_type: 'owner', scope_id: '',
      title: '会议回顾', summary: '部署评审', content: '部署评审决定周五发布。', text: '会议回顾\n部署评审决定周五发布。',
      parent_id: 'conversation:902', document_version: 'v1', chunk_index: 0, chunk_count: 1,
      updated_at: '2026-01-02T12:34:56.000Z', metadata: { message_id: '902' },
    }])
    const factory = createWebAgentRagResources({
      source: {
        pool: pool as never, files: { async read() { return null } }, memoryStorageRoot: directory,
        redis: { async get() { return null } }, serverTimezone: 'UTC', now: () => 0,
        external: { async loadImChannels() { return {} }, async loadImMemory() { return {} }, async loadKnowledge() { return [] } },
        builder: { now: () => 0, staticPrompt: () => ({ base: '', persona: '', skills: '', policy: '', retrieval: '', skillIndex: '', timezone: 'UTC', now: new Date(0) }), sessionInfo: () => ({}), systemInMessages: () => false },
      },
      rag: { core, pool: pool as never, storageRoot: directory, enabled: () => true },
      remaining: {
        context: { digest, nextId: randomUUID, finalization: { async complete() {} } },
        preparation: { capabilities: { async filterConfigured() { return [] } } },
      } as never,
    })
    const selection: ContextSourceSelection = {
      modelIdentity: 'synthetic-model', contextWindow: 10000, locale: 'zh-CN', groupChat: false,
      workspaceBinding: null, contextPolicy: { loadOwnerContext: true, memoryEnabled: true }, contextScopeKey: lease.input.accessVersion,
    }
    const resources = await factory(lease, { selection } as never)
    const result = await resources.ragContext({
      ownerId, sessionId: lease.identity.sessionId, query: '部署评审', history: [],
      beforeMessageId: null, snapshotText: '',
    } as never, new AbortController().signal)
    assert.match(JSON.stringify(result), /2026-01-02 20:34/u)
  } finally {
    await core?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
