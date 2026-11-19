import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { createScheduledTaskDeleteTool, createScheduledTaskWriteTools, createConfirmationGate, createToolRegistry } from '@gugu/core/tools'
import type { ConfirmationIntent } from '@gugu/core/tools'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createApp } from '../../src/app.js'
import { signedUserToken } from '../helpers/auth.js'
import { createBorrowedPostgresTaskWrites, createPostgresTaskWrites } from '../../src/modules/scheduled-tasks/persistence/task-writes-postgres.js'
import { createPostgresTaskResolver } from '../../src/modules/scheduled-tasks/persistence/task-resolver-postgres.js'
import { createPostgresTaskExternal } from '../../src/modules/scheduled-tasks/persistence/task-external-postgres.js'
import { createWebAgentScheduledTaskWrites } from '../../src/modules/agent-sessions/tools/agent-scheduled-task-writes.js'
import { createWebAgentConfirmationAuthorization } from '../../src/modules/agent-sessions/tools/agent-confirmation.js'
import { createWebAgentRagRunAuthorization } from '../../src/modules/agent-sessions/tools/agent-rag-run-authorization.js'
import { createRedisNotificationPublisher, createRedisScheduledTaskCommands } from '../../src/adapters/cache/redis-events.js'
import { createScheduledTaskRunNowRuntime } from '../../src/modules/scheduled-tasks/run-now-runtime.js'
import { createPostgresScheduledTaskResultDelivery } from '../../src/modules/scheduled-tasks/test-notify-postgres.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
test('定时任务写入验证 owner、事务与实际到期消费', { skip: !url }, async t => {
  const admin = new Pool({ connectionString: url }), schema = `gugu_task_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
  try {
    await pool.query(`CREATE TABLE calendar_events(id int PRIMARY KEY,user_id uuid,deleted_at timestamptz,date text,time text);
      CREATE TABLE workspaces(id int PRIMARY KEY,user_id uuid,enabled boolean);
      CREATE TABLE files(id int PRIMARY KEY,user_id uuid,deleted_at timestamptz);
      CREATE TABLE user_bots(id int PRIMARY KEY,user_id uuid,platform text,enabled boolean,owner_platform_user_id text);
      CREATE TABLE conversation_sessions(id int PRIMARY KEY,user_id uuid,source text,chat_type text,chat_id text,bot_id text);
      CREATE TABLE filesystem_authorization_grants(id int PRIMARY KEY,user_id uuid,revoked_at timestamptz,updated_at timestamptz);
      CREATE TABLE security_events(user_id uuid,event_type text,resource_type text,resource_fingerprint text,owner_fingerprint text,client_fingerprint text,ip_fingerprint text,user_agent_fingerprint text,action text,reason_code text,metadata_json jsonb,occurred_at timestamptz,expires_at timestamptz);
      CREATE TABLE scheduled_tasks(id serial PRIMARY KEY,user_id uuid,event_id int,workspace_id int,filesystem_authorization_grant_id int,name text,payload text,cron text,schedule_kind text,interval_minutes int,start_at timestamptz,end_at timestamptz,channels text,enabled boolean,delivery_targets json,authorized_tools json,email_attachment_file_ids json,reminder_lead_minutes int,last_run_at timestamptz,last_run_failed boolean,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE rag_index_jobs(id bigserial PRIMARY KEY,user_id uuid NOT NULL,source_type text NOT NULL,source_id text NOT NULL,pending_source_ids json,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation int NOT NULL,completed_generation int NOT NULL,attempts int NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_error_code text,last_started_at timestamptz,last_succeeded_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type));
      CREATE UNIQUE INDEX task_event ON scheduled_tasks(user_id,event_id,cron) WHERE event_id IS NOT NULL;
      CREATE TABLE undo_operations(id text PRIMARY KEY,user_id uuid,undo_context_id text,actor_type text,resource text,action text,status text,created_at timestamptz,after_state json,target_refs json,base_versions json)`)
    await pool.query("INSERT INTO calendar_events VALUES(1,$1,NULL,'2099-01-01','09:00')", [owner])
    await pool.query('INSERT INTO workspaces VALUES (1,$1,TRUE),(2,$2,TRUE)', [owner, other])
    await pool.query('INSERT INTO files VALUES (1,$1,NULL),(2,$2,NULL)', [owner, other])
    await pool.query("INSERT INTO user_bots VALUES (10,$1,'qq',TRUE,'owner'),(11,$2,'qq',TRUE,'other')", [owner, other])
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'qq','group','owned','10'),(2,$2,'qq','group','foreign','11')", [owner, other])
    let reject = false, events = 0
    let revoked = 0
    const external = createPostgresTaskExternal({ secretKey: 'synthetic-secret', async readWechatPrivate() { return null }, async revokeConfirmation() { revoked++ } })
    const resolve = createPostgresTaskResolver({ ...external, async resolveDelivery(...args) { if (reject) throw new Error('目标不可用'); return external.resolveDelivery(...args) } })
    const writes = createPostgresTaskWrites(pool, { validateCron() {}, filesystemAuthorizationEnabled: () => false,
      resolve,
      async publish() { events++ },
    })
    const input = { name: '提醒', schedule_kind: 'once', start_at: '2099-01-01T08:00:00.123456', event_id: 1, workspace_id: 1, email_attachment_file_ids: [1,1] }
    const secret = 'synthetic-task-write-secret'
    const app = createApp({ appName: 'Gugu', isReady: async () => true,
      userAuth: { secret, lookupUser: async id => ({ id, username: 'synthetic', displayName: null, email: 'synthetic@example.test', isActive: true, accountStatus: 'active', securityVersion: 1, avatarUrl: null, createdAt: null, timezone: null, emailSubscribed: false, imChannels: [] }) },
      scheduledTaskWrites: writes,
    })
    try {
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', payload: input })).statusCode, 401)
      const headers = { authorization: `Bearer ${signedUserToken(secret, owner)}` }
      const created = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', headers, payload: input })
      assert.equal(created.statusCode, 201, created.body)
      const createJob = (await pool.query('SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type=$2', [owner, 'scheduled_task'])).rows[0]
      assert.equal(createJob.source_id, String(created.json().id))
      assert.deepEqual(createJob.pending_source_ids, [String(created.json().id)])
      assert.equal(createJob.generation, 1)
      const duplicate = await app.inject({ method: 'POST', url: '/api/v1/scheduled-tasks', headers, payload: input })
      assert.equal(duplicate.statusCode, 200, duplicate.body)
      assert.equal(duplicate.json().id, created.json().id)
      assert.equal((await pool.query('SELECT generation FROM rag_index_jobs WHERE user_id=$1 AND source_type=$2', [owner, 'scheduled_task'])).rows[0].generation, 1)
      const foreignHeaders = { authorization: `Bearer ${signedUserToken(secret, other)}` }
      assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/scheduled-tasks/${created.json().id}`, headers: foreignHeaders, payload: { name: '越权' } })).statusCode, 404)
      const invalid = await app.inject({ method: 'PATCH', url: `/api/v1/scheduled-tasks/${created.json().id}`, headers, payload: { name: '必须回滚', workspace_id: 2 } })
      assert.equal(invalid.statusCode, 400)
      assert.equal((await pool.query('SELECT name FROM scheduled_tasks WHERE id=$1', [created.json().id])).rows[0].name, '提醒')
    } finally { await app.close() }
    const [a, b] = await Promise.all([writes.create(owner, input, null, null), writes.create(owner, input, null, null)])
    assert.equal(a.task.id, b.task.id)
    assert.equal(a.task.start_at, '2099-01-01T00:00:00.123456Z')
    assert.equal(events, 1)
    await assert.rejects(writes.create(owner, { ...input, workspace_id: 2 }, null, null), /工作区不存在/)
    await assert.rejects(writes.create(owner, { ...input, email_attachment_file_ids: [2] }, null, null), /附件不存在/)
    await assert.rejects(writes.update(other, a.task.id, { name: '越权' }, null), /任务不存在/)
    reject = true
    await assert.rejects(writes.update(owner, a.task.id, { name: '失败', channels: ['web'] }, null), /目标不可用/)
    assert.equal((await pool.query('SELECT name FROM scheduled_tasks WHERE id=$1', [a.task.id])).rows[0].name, '提醒')
    reject = false
    await assert.rejects(writes.update(owner, a.task.id, { workspace_id: 2 }, null), /工作区不存在/)
    await assert.rejects(writes.update(owner, a.task.id, { email_attachment_file_ids: [2] }, null), /附件不存在/)
    const updated = await writes.update(owner, a.task.id, { name: '新提醒' }, null)
    assert.equal(updated.name, '新提醒')
    const updateJob = (await pool.query('SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type=$2', [owner, 'scheduled_task'])).rows[0]
    assert.deepEqual(updateJob, { source_id: String(a.task.id), pending_source_ids: [String(a.task.id)], generation: 2 })
    assert.equal(updated.start_at, '2099-01-01T00:00:00.123456Z')
    assert.equal(events, 2)
    await pool.query('UPDATE workspaces SET enabled=FALSE WHERE id=1')
    await pool.query('UPDATE files SET deleted_at=now() WHERE id=1')
    reject = true
    const retained = await writes.update(owner, a.task.id, { name: '仍可修改', channels: null }, null)
    assert.equal(retained.name, '仍可修改')
    assert.equal(retained.workspace_id, 1)
    assert.deepEqual(retained.email_attachment_file_ids, [1])
    await assert.rejects(writes.update(owner, a.task.id, { workspace_id: 1 }, null), /工作区不存在/)
    await assert.rejects(writes.update(owner, a.task.id, { email_attachment_file_ids: [1] }, null), /附件不存在/)
    reject = false
    await pool.query('UPDATE workspaces SET enabled=TRUE WHERE id=1')
    await pool.query('UPDATE files SET deleted_at=NULL WHERE id=1')
    assert.deepEqual((await writes.update(owner, a.task.id, { email_attachment_file_ids: null }, null)).email_attachment_file_ids, [])
    const rescheduled = await writes.update(owner, a.task.id, { end_at: null }, null)
    assert.equal(rescheduled.start_at, '2099-01-01T00:00:00.123456Z')
    assert.equal(rescheduled.cron, '@once:2099-01-01T00:00:00.123456+00:00')
    const standalone = await writes.create(owner, { name: '任务', schedule_kind: 'interval', interval_minutes: 5, channels: ['qq'], qq_delivery: { mode: 'group', chat_id: 'owned' } }, null, null)
    assert.equal((standalone.task.delivery_targets as any).qq.chat_id, 'owned')
    const accumulated = (await pool.query('SELECT source_id,pending_source_ids FROM rag_index_jobs WHERE user_id=$1 AND source_type=$2', [owner, 'scheduled_task'])).rows[0]
    assert.deepEqual(accumulated, { source_id: String(standalone.task.id), pending_source_ids: [String(a.task.id), String(standalone.task.id)] })
    await assert.rejects(writes.update(owner, standalone.task.id, { channels: ['qq'], qq_delivery: { mode: 'group', chat_id: 'foreign' } }, null), /找不到该群会话/)
    await pool.query('INSERT INTO filesystem_authorization_grants VALUES(5,$1,NULL,NULL)', [owner])
    await pool.query('UPDATE scheduled_tasks SET filesystem_authorization_grant_id=5 WHERE id=$1', [standalone.task.id])
    await writes.update(owner, standalone.task.id, { enabled: false }, null)
    assert.equal(revoked, 1)
    assert.ok((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=5')).rows[0].revoked_at)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM security_events')).rows[0].n, 1)
    const core = await createPostgresRuntime({ url: url!, schema })
    try {
      const abort = new Error('测试外层事务回滚')
      const options = { validateCron() {}, filesystemAuthorizationEnabled: () => false, resolve }
      await assert.rejects(core.db.transaction().execute(async tx => {
        const borrowed = createBorrowedPostgresTaskWrites(tx, options)
        const inserted = await borrowed.create(owner, { name: '外层回滚', schedule_kind: 'once', start_at: '2099-01-02T08:00:00.123456' }, null, null)
        assert.equal(inserted.task.start_at, '2099-01-02T00:00:00.123456Z')
        const changed = await borrowed.update(owner, inserted.task.id, { name: '回滚中更新' }, null)
        assert.equal(changed.name, '回滚中更新')
        assert.equal(changed.start_at, '2099-01-02T00:00:00.123456Z')
        throw abort
      }), error => error === abort)
      assert.equal((await pool.query("SELECT 1 FROM scheduled_tasks WHERE name IN ('外层回滚','回滚中更新')")).rowCount, 0)
      await assert.rejects(core.db.transaction().execute(tx =>
        createBorrowedPostgresTaskWrites(tx, options).update(owner, a.task.id, { name: '非法提醒更新' }, null)), /任务不存在/)
      assert.equal((await pool.query('SELECT name FROM scheduled_tasks WHERE id=$1', [a.task.id])).rows[0].name, '仍可修改')
      await pool.query(tablesSql('postgres').receipts)
      const published: number[] = []
      let failAfterWrite = false
      let allowed = true
      const registry = createToolRegistry({
        authorize: async candidate => candidate.ownerId === owner,
        tools: createScheduledTaskWriteTools(core, {
          capabilities: { workspaceSupported: true, filesystemAuthorizationEnabled: false },
          async authorize(_tx, candidate) { return allowed && candidate.ownerId === owner },
          async delivery(_tx, candidate, requested) {
            assert.equal(candidate.ownerId, owner)
            assert.notEqual(requested.mode, 'current_group')
            return {}
          },
          async create(tx, ownerId, input) {
            const result = await createBorrowedPostgresTaskWrites(tx, options).create(ownerId, input, null, null)
            if (failAfterWrite) throw abort
            return result.task.id
          },
          async update(tx, ownerId, id, fields) {
            await createBorrowedPostgresTaskWrites(tx, options).update(ownerId, id, fields, null)
            if (failAfterWrite) throw abort
          },
          async publish(_owner, _operation, id) { published.push(id) },
        }),
      })
      const identity = { ownerId: owner, sessionId: '8', runId: 'synthetic-scheduled-writes' }
      const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
        async execute() { throw new Error('测试不调用执行器') } }
      const createArgs = { schedule_name: '  调度调用  ', instruction: '  合成指令  ', schedule_kind: 'once', start_at: '2099-01-02T08:00:00.123456' }
      const call = { id: 'create', name: 'create_scheduled_task', input: createArgs }
      const invalidWindow = await registry.tools.dispatch({
        ...call, id: 'invalid-window', input: { ...createArgs, start_at: 'invalid' },
      }, scope)
      assert.ok(invalidWindow.kind === 'completed' && !invalidWindow.successful && !invalidWindow.mutated)
      const windowError = invalidWindow.value as { error: string; field: string; message: string }
      assert.equal(windowError.error, '定时规则校验失败')
      assert.equal(windowError.field, 'start_at')
      assert.equal(windowError.message, 'start_at 必须是合法的 ISO 日期时间')
      for (const [input, error] of [
        [{ workspace_id: 2 }, '工作区不存在或已停用'],
        [{ email_attachment_file_ids: [2] }, '定时任务附件不存在、已删除或不属于当前用户'],
      ] as const) {
        const rejected = await registry.tools.dispatch({ ...call, id: 'invalid-reference', input: { ...createArgs, ...input } }, scope)
        assert.ok(rejected.kind === 'completed' && !rejected.successful && !rejected.mutated)
        assert.equal((rejected.value as { error: string }).error, error)
      }
      const readJob = async () => (await pool.query('SELECT generation,pending_source_ids FROM rag_index_jobs WHERE user_id=$1 AND source_type=$2', [owner, 'scheduled_task'])).rows[0]
      const previousJob = await readJob()
      failAfterWrite = true
      assert.equal((await registry.tools.dispatch(call, scope)).kind, 'unknown')
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM scheduled_tasks WHERE name='调度调用'")).rows[0].count, 0)
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM core_operation_receipts')).rows[0].count, 0)
      assert.deepEqual(await readJob(), previousJob)
      assert.equal(published.length, 0)
      failAfterWrite = false
      const created = await registry.tools.dispatch(call, scope)
      assert.equal(created.kind, 'completed')
      if (created.kind !== 'completed') throw new Error('未提交测试任务')
      const output = created.value as { task_id: number; name: string; instruction: string; schedule_status: string; start_at: string }
      assert.equal(output.name, '调度调用')
      assert.equal(output.instruction, '合成指令')
      assert.equal(output.schedule_status, 'active')
      assert.equal(output.start_at, '2099-01-02T00:00:00.123456Z')
      const createdJob = await readJob()
      assert.equal(createdJob.generation, previousJob.generation + 1)
      assert.ok(createdJob.pending_source_ids.includes(String(output.task_id)))
      assert.deepEqual(await registry.tools.dispatch(call, scope), { ...created, mutated: false })
      assert.deepEqual(await registry.tools.reconcile(call, { ...identity, roundId: scope.roundId }), { ...created, mutated: false })
      const update = { id: 'update', name: 'update_scheduled_task', input: { task: '调度调用', schedule_name: '调度已更新' } }
      const changed = await registry.tools.dispatch(update, scope)
      assert.equal(changed.kind, 'completed')
      if (changed.kind !== 'completed') throw new Error('未提交测试更新')
      assert.equal((changed.value as { name: string }).name, '调度已更新')
      assert.equal((changed.value as { start_at: string }).start_at, output.start_at)
      assert.deepEqual(await registry.tools.dispatch(update, scope), { ...changed, mutated: false })
      assert.equal((await readJob()).generation, createdJob.generation + 1)
      assert.deepEqual(published, [output.task_id, output.task_id])
      allowed = false
      const denied = await registry.tools.dispatch({ ...update, id: 'revoked', input: { task_id: output.task_id, instruction: '不得改写' } }, scope)
      assert.equal(denied.kind === 'completed' && denied.successful, false)
      assert.equal((await pool.query('SELECT payload FROM scheduled_tasks WHERE id=$1', [output.task_id])).rows[0].payload, '合成指令')
      let intent: ConfirmationIntent | undefined
      const gate = createConfirmationGate({
        now: () => 0,
        authorize: async candidate => candidate.ownerId === owner ? 'synthetic-permission' : null,
        async prepare(binding, snapshot) {
          intent = { schemaVersion: 2, binding, intentId: 'intent', operationId: 'operation', interactionId: 'confirm',
            purpose: 'action', action: 'delete_scheduled_task', expiresAt: 1000, authorizationEpoch: 'synthetic-permission',
            targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest }
          return intent
        },
        async inspect() { return intent ?? null },
        async load() {
          if (!intent) return null
          return { intent, receipt: { schemaVersion: 2, intentId: intent.intentId, interactionId: intent.interactionId,
            binding: intent.binding, purpose: intent.purpose, action: intent.action, expiresAt: intent.expiresAt,
            receiptId: 'approved', status: 'approved' } }
        },
      }, { action: 'delete_scheduled_task', purpose: 'action' })
      let claimed = 0
      const deleteRegistry = createToolRegistry({
        authorize: async candidate => candidate.ownerId === owner,
        tools: [createScheduledTaskDeleteTool(core, {
          gate, async claim() { claimed++; return true },
        }, async (_, id) => { published.push(id) })],
      })
      const remove = { id: 'delete', name: 'delete_scheduled_task', input: { task_id: output.task_id } }
      assert.equal((await deleteRegistry.tools.dispatch(remove, scope)).kind, 'waiting')
      assert.equal((await pool.query('SELECT 1 FROM scheduled_tasks WHERE id=$1', [output.task_id])).rowCount, 1)
      const approved = { ...scope, resolution: { interactionId: 'confirm', receiptId: 'approved', status: 'confirmed' as const, value: null } }
      const deleted = await deleteRegistry.tools.dispatch(remove, approved)
      assert.equal(deleted.kind === 'completed' && deleted.successful, true)
      assert.equal((await pool.query('SELECT 1 FROM scheduled_tasks WHERE id=$1', [output.task_id])).rowCount, 0)
      assert.deepEqual(await deleteRegistry.tools.dispatch(remove, approved), { ...deleted, mutated: false })
      assert.equal(claimed, 1)

      await pool.query(`ALTER TABLE conversation_sessions ADD COLUMN active_run_id text;
        CREATE TABLE users(id uuid PRIMARY KEY,security_version int,is_active bool,account_status text);
        CREATE TABLE agent_run_dispatch(user_id uuid,session_id int,run_id text,token text,fence int,state text,lease_expires_at timestamptz);
        CREATE TABLE agent_run_leases(user_id uuid,session_id int,run_id text,expires_at timestamptz)`)
      await pool.query("INSERT INTO users VALUES ($1,1,true,'active')", [owner])
      await pool.query("INSERT INTO conversation_sessions(id,user_id,source,active_run_id) VALUES(8,$1,'web',$2)", [owner, identity.runId])
      await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,8,$2,'synthetic-fence',1,'selected',NOW()+interval '5 minutes')", [owner, identity.runId])
      await pool.query("INSERT INTO agent_run_leases VALUES ($1,8,$2,NOW()+interval '5 minutes')", [owner, identity.runId])
      const version = 'a'.repeat(64)
      const lease = { identity, token: 'synthetic-fence', fence: 1, mode: 'start' as const, cancelRequested: false,
        input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: version } }
      const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() { return version } })
      const revokeIdentities: string[] = []
      const hostOptions = { writes: options, authorize: authority.authorizeInTransaction, accessVersion: version,
        filesystemRevocation: {
          async revokeConfirmation(_owner: string, _summary: string, identity: string) { revokeIdentities.push(identity) },
          fingerprint: (subject: string) => `synthetic-task-${subject}`,
        },
        workers: { once: true, repeating: false }, async emailAvailable() { return false }, imEnabled: (platform: string) => platform === 'qq',
        async publish(_owner: string, _operation: string, id: number) { published.push(id) } }
      assert.equal(createWebAgentScheduledTaskWrites(core, { ...hostOptions, workers: { once: false, repeating: false } }), undefined)
      const webTools = createWebAgentScheduledTaskWrites(core, hostOptions)!
      const authorization = createWebAgentRagRunAuthorization(pool, lease, { enabledScheduledTaskWrites: true })
      const web = createToolRegistry({ authorize: authorization.authorize, tools: webTools })
      const invoke = (id: string, input: Record<string, unknown>) =>
        web.tools.dispatch({ ...call, id, input: { ...createArgs, ...input } }, scope)
      for (const [id, input, error] of [
        ['no-consumer', { schedule_kind: 'interval', interval_minutes: 5 }, '该类型的定时任务消费者未启用'],
        ['no-email', { channels: ['email'] }, '当前账号的邮件提醒投递不可用'],
        ['no-group', { channels: ['qq'], delivery_mode: 'current_group' }, '只有当前 QQ 群聊的可信运行可以设置群投递'],
        ['no-workspace', { workspace_id: 1 }, '该任务的工作区、文件或自动发送邮件授权暂不可用'],
      ] as const) {
        const rejected = await invoke(id, input)
        assert.ok(rejected.kind === 'completed' && !rejected.successful)
        assert.equal((rejected.value as { error: string }).error, error)
        assert.equal((rejected.value as { tool: string }).tool, 'create_scheduled_task')
      }
      const disabled = await invoke('disabled', { enabled: false })
      assert.ok(disabled.kind === 'completed' && disabled.successful)
      assert.equal(Object.hasOwn(disabled.value as object, 'note'), false)
      const privateCall = await invoke('private', { channels: ['qq'], schedule_name: '私聊定时' })
      assert.ok(privateCall.kind === 'completed' && privateCall.successful)
      const privateId = (privateCall.value as { task_id: number }).task_id
      const privateRow = (await pool.query('SELECT delivery_targets FROM scheduled_tasks WHERE id=$1', [privateId])).rows[0]
      assert.deepEqual(privateRow.delivery_targets.qq, { platform: 'qq', chat_type: 'c2c', chat_id: null, puid: 'owner', channel_id: '10' })
      await pool.query("UPDATE user_bots SET owner_platform_user_id='rebound' WHERE id=10")
      const privateUpdate = { ...update, id: 'stale-target', input: { task_id: privateId, instruction: '不得投递旧账号' } }
      const staleTarget = await web.tools.dispatch(privateUpdate, scope)
      assert.ok(staleTarget.kind === 'completed' && !staleTarget.successful)
      assert.equal((staleTarget.value as { error: string }).error, '定时任务私聊投递归属已变化')
      assert.equal((staleTarget.value as { tool: string }).tool, 'update_scheduled_task')
      const refreshed = await web.tools.dispatch({ ...privateUpdate, id: 'refresh-target', input: { task_id: privateId, delivery_mode: 'owner_private' } }, scope)
      assert.ok(refreshed.kind === 'completed' && refreshed.successful)
      assert.equal((await pool.query("SELECT delivery_targets->'qq'->>'puid' AS recipient FROM scheduled_tasks WHERE id=$1", [privateId])).rows[0].recipient, 'rebound')
      await t.test('Agent 单项和批量撤销任务文件授权，越权无副作用且重放不重复审计', async () => {
        const disabledId = (disabled.value as { task_id: number }).task_id
        const foreignId = (await pool.query("INSERT INTO scheduled_tasks(user_id,name,enabled) VALUES ($1,'其他用户任务',true) RETURNING id", [other])).rows[0].id
        await pool.query("INSERT INTO filesystem_authorization_grants VALUES (51,$1,NULL,NULL),(52,$1,NOW(),NULL),(53,$2,NULL,NULL),(54,$1,NULL,NULL)", [owner, other])
        await pool.query("UPDATE scheduled_tasks SET filesystem_authorization_grant_id=51 WHERE id=$1", [privateId])
        await pool.query("UPDATE scheduled_tasks SET filesystem_authorization_grant_id=52 WHERE id=$1", [disabledId])
        await pool.query("UPDATE scheduled_tasks SET filesystem_authorization_grant_id=53 WHERE id=$1", [foreignId])
        const revoke = (id: string, input: Record<string, unknown>) =>
          web.tools.dispatch({ ...update, id, input }, scope)
        const denied = await revoke('revoke-other-task', { task_ids: [privateId, foreignId], filesystem_authorized: false })
        assert.ok(denied.kind === 'completed' && !denied.successful)
        assert.deepEqual(revokeIdentities, [])
        assert.equal((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=51')).rows[0].revoked_at, null)
        const grant = await revoke('cannot-grant', { task_id: privateId, filesystem_authorized: true })
        assert.ok(grant.kind === 'completed' && !grant.successful)
        assert.deepEqual(revokeIdentities, [])

        // 旧投递目标已失效时也能单独收回权限，不修改启停或目标。
        await pool.query("UPDATE user_bots SET owner_platform_user_id='changed-again' WHERE id=10")
        const batchInput = { task_ids: [privateId, disabledId], filesystem_authorized: false }
        const batch = await revoke('revoke-batch', batchInput)
        assert.ok(batch.kind === 'completed' && batch.successful && batch.mutated)
        assert.deepEqual(batch.value, { success: true, filesystem_authorized: false, task_ids: [disabledId, privateId], changed_count: 1 })
        assert.deepEqual(await revoke('revoke-batch', batchInput), { ...batch, mutated: false })
        assert.deepEqual(revokeIdentities, [`scheduled-task:filesystem:${disabledId}`, `scheduled-task:filesystem:${privateId}`])
        assert.deepEqual((await pool.query('SELECT id,enabled,filesystem_authorization_grant_id FROM scheduled_tasks WHERE id IN ($1,$2,$3) ORDER BY id', [disabledId, privateId, foreignId])).rows, [
          { id: disabledId, enabled: false, filesystem_authorization_grant_id: null },
          { id: privateId, enabled: true, filesystem_authorization_grant_id: null },
          { id: foreignId, enabled: true, filesystem_authorization_grant_id: 53 },
        ])
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM security_events WHERE metadata_json->>'grant_id'='51'")).rows[0].n, 1)

        await pool.query('UPDATE scheduled_tasks SET filesystem_authorization_grant_id=54 WHERE id=$1', [privateId])
        const stop = await revoke('disable-with-grant', { task_id: privateId, enabled: false })
        assert.ok(stop.kind === 'completed' && stop.successful)
        assert.deepEqual((await pool.query('SELECT enabled,filesystem_authorization_grant_id FROM scheduled_tasks WHERE id=$1', [privateId])).rows[0],
          { enabled: false, filesystem_authorization_grant_id: null })
        assert.ok((await pool.query('SELECT revoked_at FROM filesystem_authorization_grants WHERE id=54')).rows[0].revoked_at)
        const single = await revoke('revoke-single', { task_id: privateId, filesystem_authorized: false })
        assert.ok(single.kind === 'completed' && single.successful)
        assert.equal(revokeIdentities.length, 4)
      })
      await t.test('写入定时邮件预授权须确认，绑定参数与目标版本并支持重放', async () => {
        const gates = (tool: 'create_scheduled_task' | 'update_scheduled_task') => {
          let intent: ConfirmationIntent | undefined
          return { gate: createConfirmationGate({
            now: () => 1, async authorize() { return 'synthetic-permission' },
            async prepare(binding, snapshot) {
              assert.match(snapshot.displaySummary ?? '', /无需逐次确认/u)
              return intent = { schemaVersion: 2, binding, intentId: 'email-intent', operationId: 'email-operation', interactionId: 'email-confirm',
                purpose: 'action', action: tool, expiresAt: 1000, authorizationEpoch: 'synthetic-permission',
                targetsDigest: snapshot.targetsDigest, versionsDigest: snapshot.versionsDigest }
            },
            async inspect() { return intent ?? null },
            async load() {
              if (!intent) return null
              return { intent, receipt: { schemaVersion: 2, intentId: intent.intentId, interactionId: intent.interactionId,
                binding: intent.binding, purpose: intent.purpose, action: intent.action, expiresAt: intent.expiresAt,
                receiptId: 'email-approved', status: 'approved' } }
            },
          }, { action: tool, purpose: 'action' }), async claim() { claims++; return true } }
        }
        let claims = 0, emailAvailable = true
        const tools = createWebAgentScheduledTaskWrites(core, { ...hostOptions, async emailAvailable() { return emailAvailable },
          emailAuthorization: { create_scheduled_task: gates('create_scheduled_task'), update_scheduled_task: gates('update_scheduled_task') } })!
        const registry = createToolRegistry({ authorize: authorization.authorize, tools })
        const create = { ...call, id: 'preauthorize-create', input: { ...createArgs, schedule_name: '合成定时邮件', authorized_tools: ['send_email'] } }
        const existing = await web.tools.dispatch(create, scope)
        assert.ok(existing.kind === 'completed' && !existing.successful)
        const confirmed = { ...scope, resolution: { interactionId: 'email-confirm', receiptId: 'email-approved', status: 'confirmed' as const, value: null } }
        assert.equal((await registry.tools.dispatch(create, scope)).kind, 'waiting')
        assert.equal((await pool.query('SELECT 1 FROM scheduled_tasks WHERE name=$1', [create.input.schedule_name])).rowCount, 0)
        const tampered = await registry.tools.dispatch({ ...create, input: { ...create.input, instruction: '改变后的指令' } }, confirmed)
        assert.ok(tampered.kind === 'completed' && !tampered.successful)
        assert.equal(claims, 0)
        const created = await registry.tools.dispatch(create, confirmed)
        assert.ok(created.kind === 'completed' && created.successful && created.mutated)
        const createdId = (created.value as { task_id: number }).task_id
        const storedTools = async () => (await pool.query('SELECT authorized_tools FROM scheduled_tasks WHERE user_id=$1 AND id=$2', [owner, createdId])).rows[0].authorized_tools
        assert.deepEqual(await storedTools(), ['send_email'])
        assert.deepEqual(await registry.tools.dispatch(create, confirmed), { ...created, mutated: false })
        assert.equal(claims, 1)

        const revoke = { ...update, id: 'revoke-email', input: { task_id: createdId, authorized_tools: [] } }
        const revoked = await registry.tools.dispatch(revoke, scope)
        assert.ok(revoked.kind === 'completed' && revoked.successful)
        assert.deepEqual(await storedTools(), [])
        const edit = { ...update, id: 'preauthorize-update', input: { task_id: createdId, authorized_tools: ['send_email'] } }
        assert.equal((await registry.tools.dispatch(edit, scope)).kind, 'waiting')
        await pool.query("UPDATE scheduled_tasks SET updated_at=updated_at+interval '1 second' WHERE id=$1", [createdId])
        const stale = await registry.tools.dispatch(edit, confirmed)
        assert.ok(stale.kind === 'completed' && !stale.successful)
        assert.deepEqual(await storedTools(), [])
        assert.equal(claims, 1)
        const refreshed = { ...edit, id: 'preauthorize-current-version' }
        assert.equal((await registry.tools.dispatch(refreshed, scope)).kind, 'waiting')
        emailAvailable = false
        const missing = await registry.tools.dispatch(refreshed, confirmed)
        assert.ok(missing.kind === 'completed' && !missing.successful)
        assert.deepEqual(await storedTools(), [])
        emailAvailable = true
        const granted = await registry.tools.dispatch(refreshed, confirmed)
        assert.ok(granted.kind === 'completed' && granted.successful)
        assert.deepEqual(await storedTools(), ['send_email'])
      })
      await pool.query("UPDATE users SET is_active=false WHERE id=$1", [owner])
      const revokedOwner = await invoke('revoked-owner', { schedule_name: '不能提交' })
      assert.ok(revokedOwner.kind === 'completed' && !revokedOwner.successful)
      assert.equal((await pool.query("SELECT 1 FROM scheduled_tasks WHERE name='不能提交'")).rowCount, 0)

      await t.test('Agent 创建并更新的任务由一次性与周期 Worker 投递到当前 owner', { skip: !redisUrl }, async () => {
        await pool.query(tablesSql('postgres').scheduledFires)
        await pool.query(`CREATE TABLE site_notifications(id serial PRIMARY KEY,title text,content text,color text,target text,bubble boolean,persist boolean,
          bubble_expire_at timestamptz,created_by text,created_at timestamptz)`)
        await pool.query('UPDATE users SET is_active=true WHERE id=$1', [owner])
        const attempts: Array<{ ownerId: string; payload: string }> = []
        const runtime = createScheduledTaskRunNowRuntime({
          db: core.db, backend: 'postgres', redis: createRedisScheduledTaskCommands(redisUrl!),
          async notifyTasksChanged() {},
          execution: {
            async attempt({ task, assertLease }) {
              assert.ok(assertLease)
              await assertLease()
              attempts.push({ ownerId: task.ownerId, payload: task.payload })
              return { status: 'success', effects: 'none', text: task.payload, files: [] }
            },
            deliver: createPostgresScheduledTaskResultDelivery(pool, createRedisNotificationPublisher(redisUrl!), {
              async email() { throw new Error('本任务仅启用站内通知') },
            }),
          },
        })
        const once = runtime.createOnceWorker()
        const repeating = runtime.createRepeatingWorker()
        const refresh = async () => { await Promise.all([once.refresh(), repeating.refresh()]) }
        const both = createToolRegistry({
          authorize: authorization.authorize,
          tools: createWebAgentScheduledTaskWrites(core, { ...hostOptions, workers: { once: true, repeating: true }, publish: refresh })!,
        })
        await repeating.start()
        once.start()
        await refresh()
        const fireAt = new Date(Date.now() + 3500).toISOString()
        const createTask = async (kind: 'once' | 'interval', name: string) => {
          const result = await both.tools.dispatch({
            ...call, id: name,
            input: { schedule_name: name, instruction: '更新前内容', schedule_kind: kind, start_at: fireAt,
              ...(kind === 'interval' ? { interval_minutes: 1 } : {}) },
          }, scope)
          assert.ok(result.kind === 'completed' && result.successful, JSON.stringify(result))
          const id = (result.value as { task_id: number }).task_id
          const modified = await both.tools.dispatch({
            ...update, id: `edit-${id}`, input: { task_id: id, instruction: `${name}已执行` },
          }, scope)
          assert.ok(modified.kind === 'completed' && modified.successful, JSON.stringify(modified))
          return id
        }
        const deadline = AbortSignal.timeout(9000)
        try {
          const onceId = await createTask('once', '一次性合成通知')
          const intervalId = await createTask('interval', '周期合成通知')
          for (;;) {
            deadline.throwIfAborted()
            const state = await pool.query(`SELECT
              (SELECT count(*)::int FROM site_notifications) AS notices,
              EXISTS(SELECT 1 FROM scheduled_tasks WHERE id=$1) AS once_pending,
              (SELECT status FROM scheduled_task_fires WHERE task_id=$2) AS fire_status`, [onceId, intervalId])
            const row = state.rows[0]
            if (row.notices === 2 && !row.once_pending && row.fire_status === 'completed') break
            await delay(30, undefined, { signal: deadline })
          }
        } finally {
          await Promise.all([once.stop(), repeating.stop()])
        }
        const notifications = (await pool.query<{ target: string; content: string }>('SELECT target,content FROM site_notifications')).rows
        assert.ok(notifications.every(item => item.target === owner))
        assert.deepEqual(notifications.map(item => item.content).sort(), ['一次性合成通知已执行', '周期合成通知已执行'])
        assert.equal(attempts.length, 2)
        assert.ok(attempts.every(attempt => attempt.ownerId === owner))
      })

    } finally { await core.close() }

  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
