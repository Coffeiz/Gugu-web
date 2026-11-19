import { encryptByokEnvelope } from '../../src/modules/byok/crypto.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { serializeAgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import { stableJson, type CanonicalRunPreparationPorts } from '@gugu/core/agent'
import { createScheduledTaskContextLoader } from '@gugu/core/scheduled-task-run-now'
import { ProviderStreamSanitizer, stripThinking, type ProviderHttpRequest } from '@gugu/core/providers'
import { createConfiguredWebAgentProviderBinding } from '../../src/modules/agent/llm/configured.js'
import { createWebAgentPromptReader } from '../../src/modules/agent/context/prompts.js'
import { createLocalPreferenceTextFiles } from '../../src/modules/preferences/persistence/personality-files.js'
import { createWebScheduledTaskContextSources } from '../../src/modules/scheduled-tasks/run/context.js'
import { createWebScheduledTaskToolResources } from '../../src/modules/scheduled-tasks/run/tools.js'
import { createWebScheduledTaskAgentAttempt } from '../../src/modules/scheduled-tasks/run/attempt.js'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('定时执行按任务 owner 绑定 BYOK，并为每次尝试生成独立身份', { skip: !pgUrl && '需要隔离 PostgreSQL' }, async () => {
  const owner = randomUUID(), withoutByok = randomUUID()
  const directory = await mkdtemp(join(tmpdir(), 'gugu-scheduled-binding-'))
  const schema = `scheduled_model_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: pgUrl!, schema })
  const masterKey = 'synthetic-master-key'
  const credential = encryptByokEnvelope('synthetic-user-key', masterKey, 1)
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE user_provider_credentials(id int PRIMARY KEY,user_id uuid,capability text,enabled boolean,
      provider text,api_format text,base_url text,model text,encrypted_value text,nonce text,encrypted_data_key text,key_version integer,
      max_tokens integer,context_tokens integer,thinking text,reasoning_effort text,reasoning_persistence text,image boolean,
      video boolean,audio boolean,image_detail text,web_search_enabled boolean,updated_at timestamptz DEFAULT now());
      CREATE TABLE user_provider_bindings(user_id uuid,capability text,credential_id int,PRIMARY KEY(user_id,capability));
      CREATE TABLE users(id uuid PRIMARY KEY, timezone text, token_limit_6h integer, quota_window_started_at timestamptz);
      CREATE TABLE scheduled_tasks(id int PRIMARY KEY,user_id uuid,enabled boolean,
        schedule_kind text NOT NULL DEFAULT 'cron',end_at timestamptz,last_run_failed boolean);
      CREATE TABLE user_preferences(user_id uuid,data_json text);
      CREATE TABLE projects(id int PRIMARY KEY,user_id uuid,name text,status text,priority text,start_date date,deadline date,done_at timestamptz,
        contact_name text,summary text,stages_json text,deleted_at timestamptz,archived boolean);
      CREATE TABLE calendar_events(user_id uuid,date text,title text,deleted_at timestamptz);
      CREATE TABLE folders(id int PRIMARY KEY,user_id uuid,name text,project_id int,workspace_directory_id int,parent_id int,deleted_at timestamptz);
      CREATE TABLE files(id int PRIMARY KEY,user_id uuid,display_name text,ext text,space text,folder_id int,project_id int,
        deleted_at timestamptz,updated_at timestamptz);
      CREATE TABLE user_bots(user_id uuid,platform text,enabled boolean);
      CREATE TABLE agent_usage(id serial PRIMARY KEY,user_id uuid,session_id integer,tokens_in integer,tokens_out integer,
        cache_read integer,cache_write integer,cache_round_stats jsonb,model text,provider text,is_byok boolean,
        tools_used jsonb,scenario text,input_source text,created_at timestamptz)`)
    await pool.query("INSERT INTO users(id,timezone) VALUES($1,'Asia/Shanghai'),($2,'UTC')", [owner, withoutByok])
    await pool.query('INSERT INTO scheduled_tasks(id,user_id,enabled) VALUES (7,$1,TRUE),(8,$2,TRUE),(9,$1,FALSE)', [owner, withoutByok])
    await pool.query("INSERT INTO projects(id,user_id,name,status,stages_json,archived) VALUES (1,$1,'甲项目','active','[]',FALSE),(2,$2,'乙项目','active','[]',FALSE)", [owner, withoutByok])
    await pool.query("INSERT INTO calendar_events VALUES ($1,'2026-01-02','甲日历',NULL),($2,'2026-01-02','乙日历',NULL)", [owner, withoutByok])
    await pool.query("INSERT INTO files(id,user_id,display_name,ext,space) VALUES (1,$1,'甲文件','txt','personal'),(2,$2,'乙文件','txt','personal')", [owner, withoutByok])
    await pool.query("INSERT INTO user_bots VALUES ($1,'qq',TRUE),($2,'feishu',TRUE)", [owner, withoutByok])
    await pool.query('INSERT INTO user_preferences VALUES ($1,$3),($2,$3)', [owner, withoutByok, JSON.stringify({ custom_reply_style_enabled: true })])
    const files = createLocalPreferenceTextFiles(directory)
    for (const [user, label] of [[owner, '甲'], [withoutByok, '乙']] as const) {
      await files.write(user, 'reply-style', label + '风格')
      await writeFile(join(directory, user, '.agent', 'memory.md'), label + '长期记忆')
      const entries = join(directory, user, '.agent', 'knowledge', 'entries')
      await mkdir(entries, { recursive: true })
      await writeFile(join(entries, '..', '.timestamps-iso-v1'), '')
      await writeFile(join(entries, 'entry.md'), serializeAgentKnowledgeEntry({
        id: 'entry', title: label + '知识', content: '知识正文仅供按需读取', topic: '', keywords: [], description: '',
        scope: { type: 'owner', owner_user_id: user, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
        source: { type: 'user', ref: '', label: '', checked_at: null }, confidence: 'confirmed', version: 1,
        parent_id: null, created_at: 1_760_000_000, updated_at: 1_760_000_000, active: true, history: [],
      }))
    }
    await pool.query(`INSERT INTO user_provider_credentials VALUES
      (1,$1,'llm',TRUE,'openai','openai','https://user.example.test/v1','synthetic-user-model',$2,$3,$4,1,
      2048,8192,NULL,NULL,'continuation',FALSE,FALSE,FALSE,'auto',FALSE)`,
    [owner, credential.ciphertext, credential.nonce, credential.encryptedDataKey])
    await pool.query("INSERT INTO user_provider_bindings VALUES ($1,'llm',1)", [owner])
    const promptRoot = join(directory, 'prompts')
    await mkdir(promptRoot)
    for (const name of ['default.md', 'persona.md', 'skills.md', 'policy.md', 'retrieval.md'])
      await writeFile(join(promptRoot, name), '合成提示词')
    const binding = await createConfiguredWebAgentProviderBinding({
      pool, configPath: join(directory, 'test-config.json'), versionSecret: 'synthetic-version-secret', promptRoot,
      permissionIdentity: 'scheduled-task', contextPolicy: () => ({ memoryEnabled: true, loadOwnerContext: true }), defaultLimit6h: 5,
      environment: { CREDENTIALS_MASTER_KEY: masterKey, BYOK__ENABLED: 'true', AI__MODEL: 'synthetic-platform-model',
        AI__API_KEY: 'synthetic-platform-key', AI__CONTEXT_TOKENS: '4096', AI__REASONING_PERSISTENCE: 'continuation' },
    })
    const now = () => Date.parse('2026-01-01T08:00:00Z')
    const readPrompts = createWebAgentPromptReader(promptRoot)
    const contextSources = createWebScheduledTaskContextSources({
      pool, storageRoot: directory, redis: { get: async () => null }, serverTimezone: 'UTC', now,
      imPlatformEnabled: () => true,
      staticPrompt(selection, _identity, style, timezone) {
        const preferences = style as { custom_reply_style: string }
        return { ...readPrompts(), locale: selection.locale, timezone: timezone ?? 'UTC', now: new Date(now()),
          skillIndex: '', customReplyStyleEnabled: true, customReplyStyle: preferences.custom_reply_style }
      },
    })
    const toolResources = createWebScheduledTaskToolResources({ core, now: () => new Date(now()),
      timezone: identity => contextSources.data.loadTimezone(identity) })
    const signal = new AbortController().signal
    for (const taskId of ['8', '9']) {
      const identity = { ownerId: owner, sessionId: `scheduled-task:${taskId}`, runId: 'unauthorized' }
      await assert.rejects(contextSources.data.loadTimezone(identity, signal), /定时任务不存在/)
    }
    const runs: string[] = []
    const requests: ProviderHttpRequest[] = []
    const runtimeReasoningPolicies: Array<string | undefined> = []
    let failBeforeStart = false
    let usePersistedPrompt = false
    let useWrongSubject = false
    let toolCalls = 0
    let revokeLeaseOnReply: (() => void) | undefined
    let usageFailures = 0
    let assertReleased: (() => Promise<void>) | undefined
    const attempt = createWebScheduledTaskAgentAttempt({
      bindProvider: binding.bind,
      usagePool: pool,
      onUsageFailure: () => { usageFailures++ },
      async prepareHarness({ identity, task, model, prompt, assertLease }) {
        runs.push(identity.runId)
        assert.equal(identity.ownerId, task.ownerId)
        assert.equal(identity.sessionId, `scheduled-task:${task.id}`)
        const resolved = await model.resolve(identity, model.modelIdentity, signal)
        const isByok = task.ownerId === owner
        assert.equal(model.usageConfig.isByok, isByok)
        assert.equal(resolved.config.model, isByok ? 'synthetic-user-model' : 'synthetic-platform-model')
        assert.equal(resolved.config.api_key, isByok ? 'synthetic-user-key' : 'synthetic-platform-key')
        assert.equal(resolved.config.reasoning_persistence, 'continuation')
        await assert.rejects(model.resolve({ ...identity, ownerId: randomUUID() }, model.modelIdentity, signal), /身份不匹配/)
        assertReleased = async () => { await assert.rejects(model.resolve(identity, model.modelIdentity, signal), /已释放/) }
        if (failBeforeStart) throw new Error('定时 Agent 准备失败')
        const loadOwnerContext = createScheduledTaskContextLoader({
          ...contextSources, identity, task, model, prompt, memoryEnabled: true,
        })
        let modelRound = 0
        const tool = { name: 'get_current_time', schema: { type: 'function', function: {
          name: 'get_current_time', description: '合成时钟', parameters: { type: 'object', properties: {} },
        } } }
        const boundTools = await toolResources({ identity, task, assertLease: assertLease ?? (async () => {}) })
        return {
          runPreparation: {
            ...boundTools.preparation,
            capabilities: {
              ...boundTools.preparation.capabilities,
              async catalog() { return { toolCatalog: '定时工具目录', skillCatalog: '定时技能目录', userSkills: [], metadataOnly: false } },
            },
            formatPrefix({ original, snapshot }: Parameters<CanonicalRunPreparationPorts['formatPrefix']>[0]) {
              return original.fixedPrefix.map(message => {
                assert.equal(message.role, 'system')
                return { role: 'system' as const, content: String(message.content).replace(original.snapshotText ?? '', snapshot) }
              })
            },
          },
          context: {
            digest: value => createHash('sha256').update(stableJson(value)).digest('hex'),
            nextId: randomUUID,
            async load(candidate, signal) {
              assert.deepEqual(candidate, identity)
              const context = await loadOwnerContext(candidate, signal)
              return { ...context,
                ...(usePersistedPrompt ? { input: { ...context.input, currentUser: {
                  message: { role: 'user', content: prompt }, persistedMessageId: '42',
                } } } : {}),
              capabilities: { toolNames: [tool.name], tools: [tool], subject: {
                ownerId: identity.ownerId, subject: { kind: 'scheduled_task', id: useWrongSubject ? '8' : task.id }, workspaceId: null,
              } } }
            },
            preparation: { async buildRag() { assert.fail('定时任务不读取会话 RAG') } },
            async prepareRequest() { assert.fail('定时任务不从会话重建请求前缀') },
            references: { async dehydrate(entry) { return entry.message }, async hydrate(entry) { return entry.message } },
            compaction: { async summarize() { assert.fail('短任务不会压缩') } },
            finalization: { async complete() {} },
            currentRequest: () => null,
            async stageContinuation() { assert.fail('定时任务不保存推理续接') },
            async releaseContinuations() {},
            diagnoseCompactionFailure() {},
          },
          executor: { async authorize() { assert.fail('不应授权进程') },
            executor: { async execute() { assert.fail('不应执行进程') } } },
          runtime: {
            clock: { now: () => '2026-01-01T00:00:00Z' },
            tools: {
              ...boundTools.tools,
              async dispatch(call, scope) {
                assert.equal(call.name, 'get_current_time')
                assert.deepEqual(scope.identity, identity)
                toolCalls++
                return boundTools.tools.dispatch(call, scope)
              },
            },
            sanitizeText: stripThinking,
            createStreamSanitizer: () => new ProviderStreamSanitizer(),
            presentError: () => ({ code: 'failed', text: '模型不可用' }),
            async presentToolResult(value) { return value },
            diagnose() {},
          },
          provider: {
            createTransport(config) {
              runtimeReasoningPolicies.push(config.reasoning_persistence)
              return {
                async request(request) {
                  requests.push(request)
                  revokeLeaseOnReply?.()
                  const payload = ++modelRound === 1
                    ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-clock', type: 'function',
                      function: { name: tool.name, arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
                    : { choices: [{ delta: { content: '已完成' }, finish_reason: 'stop' }] }
                  return { status: 200, headers: { 'content-type': 'text/event-stream' },
                    body: (async function* () {
                      yield new TextEncoder().encode(`data: ${JSON.stringify({ ...payload,
                        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
                      })}\n\ndata: [DONE]\n\n`)
                    })(), async cancel() {} }
                },
                async close() {},
              }
            },
          },
        }
      },
    })
    const input = (ownerId: string) => ({
      task: { id: ownerId === owner ? '7' : '8', ownerId, name: '汇报', payload: '', channels: ['web'], deliveryTargets: {},
        authorizedTools: [], emailAttachmentFileIds: [], workspaceId: null, filesystemGrantId: null },
      prompt: '合成任务提示词', isTrial: true,
    })
    for (const ownerId of [owner, owner, withoutByok]) {
      assert.deepEqual(await attempt(input(ownerId)),
        { text: '已完成', status: 'success', effects: 'none', files: [] })
      await assertReleased?.()
    }
    assert.equal(new Set(runs).size, 3)
    assert.equal(requests.length, 6)
    assert.ok(runtimeReasoningPolicies.length > 0)
    assert.ok(runtimeReasoningPolicies.every(value => value === 'off'))
    assert.equal(toolCalls, 3)
    for (const [index, request] of requests.entries()) {
      const body = JSON.stringify(request.body)
      const own = index < 4 ? '甲' : '乙', other = index < 4 ? '乙' : '甲'
      assert.match(body, /合成任务提示词/u)
      for (const field of ['项目', '日历', '文件', '风格', '长期记忆', '知识']) {
        assert.ok(body.includes(own + field), field)
        assert.ok(!body.includes(other + field), field)
      }
      assert.ok(!body.includes('知识正文仅供按需读取'))
      assert.ok(body.includes(index < 4 ? 'QQ：已连' : '飞书：已连'))
      assert.ok(body.includes(index < 4 ? '飞书：未连' : 'QQ：未连'))
      assert.match(body, /一次性给出完整回复/u)
      assert.match(body, /定时工具目录/u)
      assert.match(body, /定时技能目录/u)
      assert.doesNotMatch(body, /与用户实时聊天/u)
      assert.match(body, index < 4 ? /16:00/u : /08:00/u)
    }
    assert.match(JSON.stringify(requests[1]?.body), /2026-01-01 16:00:00/u)
    usePersistedPrompt = true
    assert.equal((await attempt(input(owner))).status, 'failed')
    usePersistedPrompt = false
    useWrongSubject = true
    assert.equal((await attempt(input(owner))).status, 'failed')
    useWrongSubject = false
    assert.equal(requests.length, 6)
    assert.equal(toolCalls, 3)
    failBeforeStart = true
    await assert.rejects(attempt(input(owner)), /定时 Agent 准备失败/)
    await assertReleased?.()
    const { rows } = await pool.query('SELECT user_id,session_id,tokens_in,tokens_out,is_byok,tools_used,scenario,input_source FROM agent_usage ORDER BY id')
    const billed = { session_id: null, tools_used: ['get_current_time'], scenario: 'scheduled', input_source: null }
    assert.deepEqual(rows, [
      { ...billed, user_id: owner, tokens_in: 8, tokens_out: 4, is_byok: true },
      { ...billed, user_id: owner, tokens_in: 8, tokens_out: 4, is_byok: true },
      { ...billed, user_id: withoutByok, tokens_in: 5, tokens_out: 0, is_byok: false },
    ])
    assert.equal(usageFailures, 0)
    await pool.query('ALTER TABLE agent_usage RENAME TO unavailable_usage')
    failBeforeStart = false
    assert.equal((await attempt(input(owner))).text, '已完成')
    assert.equal(usageFailures, 1)
    const requestsBeforeRevocation = requests.length, toolsBeforeRevocation = toolCalls
    let leaseRevoked = false
    revokeLeaseOnReply = () => { leaseRevoked = true }
    const revoked = await attempt({ ...input(owner), async assertLease() {
      if (leaseRevoked) throw new Error('定时任务执行租约已失效')
    } })
    assert.equal(revoked.status, 'failed')
    assert.equal(requests.length, requestsBeforeRevocation + 1)
    assert.equal(toolCalls, toolsBeforeRevocation)
  } finally {
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally {
      await admin.end()
      await rm(directory, { recursive: true, force: true })
    }
  }
})
