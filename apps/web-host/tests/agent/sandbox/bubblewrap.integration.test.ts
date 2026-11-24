import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createAgentInteractionDescription, createAgentRunner, processOneInteraction, type AgentRunnerPorts } from '@gugu/core/agent'
import { createPostgresTrustedIntentStore } from '../../../src/modules/agent/interactions/intents.js'
import { createWebAgentConfirmationAuthorization, createWebAgentToolConfirmation } from '../../../src/modules/agent/tools/confirm.js'
import { createAgentShellSnapshotReader } from '../../../src/modules/agent/sandbox/snapshot.js'
import { createWebAgentShell } from '../../../src/modules/agent/tools/shell/sandbox.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../../src/modules/agent/rag/production.js'
import { createWorkspaceFileReads } from '../../../src/modules/workspaces/files.js'
import { executeBubblewrapShell } from '../../../src/modules/terminals/sandbox/bubblewrap.js'
import { createTerminalWorkspaceMounts } from '../../../src/modules/terminals/sandbox/mounts.js'
import { createPostgresAgentRunStore } from '../../../src/modules/agent/run/store.js'
import { createPostgresAgentRunLeasePort } from '../../../src/modules/agent/run/lease.js'
import { createPostgresInteractionActivator } from '../../../src/modules/agent/interactions/activate.js'
import { createPostgresInteractionProjection } from '../../../src/modules/agent/interactions/projection.js'
import { createInteractionResumeEnqueuer, createPostgresInteractionResumeQueue } from '../../../src/modules/agent/interactions/resume.js'
import { createTrustedPromptDescriptions } from '../../../src/modules/agent/interactions/prompts.js'
import { createAgentInteractionRespondService } from '../../../src/modules/agent/interactions/respond.js'
import { createFilesystemAuthorizationConfirmationStore } from '../../../src/modules/agent/sandbox/confirmations.js'
import { createRedisFilesystemAuthorizationCommands } from '../../../src/adapters/cache/redis-events.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const rootfs = process.env.GUGU_BUBBLEWRAP_TEST_ROOTFS
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL
test('Web Agent 通过持久确认在真实 Bubblewrap 中写入一次，异主与重放均不执行', {
  skip: (!url || !rootfs || process.platform !== 'linux') && '需要隔离 PostgreSQL 与 Linux 运行根',
  timeout: 30000,
}, async t => {
  const schema = `gugu_shell_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: url!, schema })
  const scratch = await mkdtemp(join(tmpdir(), 'gugu-agent-shell-'))
  const identity = { ownerId: randomUUID(), sessionId: '1', runId: 'synthetic-shell-run' }
  const other = randomUUID()
  const lease = {
    identity, token: 'synthetic-shell-lease', fence: 1, mode: 'start' as const, cancelRequested: false,
    input: { v: 2 as const, source: 'web' as const, userMessageId: 1, locale: null, origin: null, accessVersion: 'a'.repeat(64) },
  }
  type ShellLease = typeof lease
  const signal = new AbortController().signal
  const scope = { identity, roundId: '1', signal, resolution: null,
    async execute(): Promise<never> { throw new Error('通用执行端口不应被用来绕过 Bubblewrap') } }
  try {
    await pool.query(`${tablesSql('postgres').receipts};
      CREATE TABLE users(id uuid PRIMARY KEY,security_version integer,is_active boolean,account_status text);
      CREATE TABLE user_preferences(user_id uuid,data_json jsonb);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,active_run_id text,workspace_id integer);
      CREATE TABLE workspaces(id integer PRIMARY KEY,user_id uuid,name text,kind text,project_id integer,directory_id integer,enabled boolean);
      CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,directory_name text,is_default boolean,deleted_at timestamptz);
      CREATE TABLE filesystem_authorization_grants(id integer,user_id uuid,subject_type text,subject_id text,scope text,permission text,revoked_at timestamptz,expires_at timestamptz);
      CREATE TABLE agent_run_dispatch(user_id uuid,session_id integer,run_id text,state text,token text,fence bigint,lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid,session_id integer,run_id text,expires_at timestamptz);
      CREATE TABLE agent_interaction_intents(user_id uuid,session_id integer,run_id text,interaction_id text,tool_call_id text,
        ciphertext text,nonce text,encrypted_data_key text,key_version integer,expires_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,interaction_id));
      CREATE TABLE agent_run_interaction_receipts(user_id uuid,session_id integer,run_id text,receipt text);
      CREATE TABLE agent_interaction_bindings(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,tool_call_id text);
      CREATE TABLE agent_interaction_resumes(user_id uuid,session_id integer,run_id text,prompt_id integer,interaction_id text,receipt text);
      CREATE TABLE interaction_prompts(id integer,user_id uuid,session_id integer,kind text,status text,expires_at timestamptz,schema_json jsonb);
      CREATE TABLE interaction_actions(prompt_id integer,status text,option_id text,action_type text,context_json jsonb,expires_at timestamptz)`)
    for (const id of [identity.ownerId, other]) {
      await mkdir(join(scratch, id, 'workspace/default'), { recursive: true })
      await pool.query("INSERT INTO users VALUES ($1,1,true,'active')", [id])
    }
    const content = join(scratch, identity.ownerId, 'workspace/default', 'notes.txt')
    const neighbor = join(scratch, other, 'workspace/default', 'notes.txt')
    await writeFile(content, 'owner\n')
    await writeFile(neighbor, 'other\n')
    await pool.query('INSERT INTO conversation_sessions VALUES (1,$1,$2,1)', [identity.ownerId, identity.runId])
    await pool.query("INSERT INTO workspaces VALUES (1,$1,'默认','directory',NULL,NULL,1,true)", [identity.ownerId])
    await pool.query("INSERT INTO workspace_directories VALUES (1,$1,'default',true,NULL)", [identity.ownerId])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId, lease.token])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,1,$2,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, identity.runId])
    const intents = createPostgresTrustedIntentStore(() => 'synthetic-shell-master', 1)
    let adminSystemEnabled = false
    const read = createAgentShellSnapshotReader(pool, core.db, async () => ({
      shellEnabled: true, shellSystemEnabled: adminSystemEnabled, shellDangerousEnabled: true, sandboxEnabled: true, sandboxReady: true,
      filesystemAuthorizationEnabled: true, networkProfile: 'none',
    }))
    function registryFor(lease: ShellLease) {
      const confirmation = createWebAgentToolConfirmation({
        pool, lease, intents, action: 'shell',
        ...createWebAgentConfirmationAuthorization({ pool, lease, accessVersion: async () => lease.input.accessVersion }),
        async describe(_binding, snapshot) { return { summary: snapshot.displaySummary! } },
      })
      const shell = createWebAgentShell({
        rootfs: rootfs!, confirmation, read: current => read(current.ownerId, current.sessionId),
        mounts: createTerminalWorkspaceMounts(pool, core.db, scratch),
        claim: (reference, requestSignal) => core.db.transaction().execute(tx => confirmation.claim(tx, reference, requestSignal)),
      })
      return createAuthorizedWebAgentProductionRagRunPorts({
        core, pool, lease, shell, storageRoot: scratch, enabled: () => true,
        selection: { modelIdentity: 'synthetic', contextScopeKey: lease.input.accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      }).toolRegistry
    }
    const toolRegistry = registryFor(lease)
    const dispatch = toolRegistry.tools.dispatch
    const listing = await dispatch({ id: 'read', name: 'shell', input: { command: 'cat notes.txt' } }, scope)
    assert.ok(listing.kind === 'completed' && listing.successful, JSON.stringify(listing))
    assert.equal((listing.value as { stdout: string }).stdout, 'owner\n')
    const absoluteDirectory = await dispatch({ id: 'cwd', name: 'shell', input: { command: 'pwd', cwd: '/project' } }, scope)
    assert.ok(absoluteDirectory.kind === 'completed' && absoluteDirectory.successful)
    assert.equal((absoluteDirectory.value as { stdout: string }).stdout, '/project\n')
    const untrusted = await dispatch({ id: 'read-other', name: 'shell', input: { command: 'cat notes.txt' } }, { ...scope, identity: { ...identity, ownerId: other } })
    assert.ok(untrusted.kind === 'completed' && !untrusted.successful)
    const direct = await dispatch({ id: 'workspace-write', name: 'shell', input: {
      command: "printf 'line1\\nline2\\n' > t.txt; cat t.txt; echo \"exit=$?\"; ls -la; wc -l t.txt; grep -n line2 t.txt",
    } }, scope)
    assert.ok(direct.kind === 'completed' && direct.successful, JSON.stringify(direct))
    assert.match((direct.value as { stdout: string }).stdout, /^line1\nline2\nexit=0\n[\s\S]*2:line2\n$/)
    assert.equal(await readFile(join(scratch, identity.ownerId, 'workspace/default/t.txt'), 'utf8'), 'line1\nline2\n')
    const personalFile = join(scratch, identity.ownerId, '个人文件/keep.txt')
    await writeFile(personalFile, 'keep\n')
    await symlink('/personal/keep.txt', join(scratch, identity.ownerId, 'workspace/default/personal.txt'))
    await pool.query(`INSERT INTO filesystem_authorization_grants VALUES (1,$1,'session','1','user_sandbox','read_write',NULL,NULL)`, [identity.ownerId])
    const protectedWrite = await dispatch({ id: 'protected-write', name: 'shell', input: { command: 'printf other > /personal/keep.txt' } }, scope)
    assert.equal(protectedWrite.kind, 'waiting')
    const redirected = await dispatch({ id: 'linked-write', name: 'shell', input: { command: 'printf other > personal.txt' } }, scope)
    assert.ok(redirected.kind === 'completed' && !redirected.successful)
    assert.equal(await readFile(personalFile, 'utf8'), 'keep\n')
    await pool.query('DELETE FROM filesystem_authorization_grants WHERE id=1')
    const systemProbe = { id: 'system-gates', name: 'shell', input: { command: 'pwd', scope: 'system' } }
    const assertSystemDenied = async () => {
      const denied = await dispatch(systemProbe, scope)
      assert.ok(denied.kind === 'completed' && !denied.successful)
      assert.match(JSON.stringify(denied.value), /均需开启/)
    }
    await assertSystemDenied()
    adminSystemEnabled = true
    await assertSystemDenied()
    adminSystemEnabled = false
    await pool.query("INSERT INTO user_preferences VALUES ($1, '{\"shell_system_enabled\":true}')", [identity.ownerId])
    await assertSystemDenied()
    const call = { id: 'shell-write', name: 'shell', input: { command: 'printf "confirmed\\n" >> notes.txt 2>/dev/null' } }
    const waiting = await dispatch(call, scope)
    assert.ok(waiting.kind === 'waiting', JSON.stringify(waiting))
    assert.equal(await readFile(content, 'utf8'), 'owner\n')
    const interaction = waiting.interaction.id
    const code = 'synthetic-code'
    await pool.query('INSERT INTO agent_interaction_bindings VALUES ($1,1,$2,9,$3,$4)', [identity.ownerId, identity.runId, interaction, call.id])
    await pool.query("INSERT INTO agent_interaction_resumes VALUES ($1,1,$2,9,$3,'web-prompt:9')", [identity.ownerId, identity.runId, interaction])
    await pool.query("INSERT INTO agent_run_interaction_receipts VALUES ($1,1,$2,'web-prompt:9')", [identity.ownerId, identity.runId])
    await pool.query("INSERT INTO interaction_prompts VALUES (9,$1,1,'confirm','resolved',CURRENT_TIMESTAMP+interval '2 minutes',$2)", [identity.ownerId,
      { context: { confirm_code: code }, resolved_result: { status: 'confirmed', option_id: 'confirm', confirm: true } }])
    await pool.query("INSERT INTO interaction_actions VALUES (9,'consumed','confirm','confirm',$1,CURRENT_TIMESTAMP+interval '2 minutes')",
      [{ tool_call_id: call.id, tool_name: 'shell', confirm_code: code }])
    const resume = { ...scope, resolution: { interactionId: interaction, receiptId: 'web-prompt:9', status: 'confirmed' as const, value: {} } }
    const tampered = await dispatch({ ...call, input: { command: 'echo altered >> notes.txt' } }, resume)
    assert.ok(tampered.kind === 'completed' && !tampered.successful)
    const resumed = await dispatch(call, resume)
    assert.ok(resumed.kind === 'completed' && resumed.successful, JSON.stringify(resumed))
    const replay = await dispatch(call, resume)
    assert.ok(replay.kind === 'completed' && !replay.successful)
    assert.equal(await readFile(content, 'utf8'), 'owner\nconfirmed\n')
    assert.equal(await readFile(neighbor, 'utf8'), 'other\n')
    await t.test('确认后的 rm 回收真实磁盘文件，复用文件库恢复，脚本不能绕过', async () => {
      const mounts = createTerminalWorkspaceMounts(pool, core.db, scratch)
      const execute = async (command: string) => executeBubblewrapShell(rootfs!,
        await mounts(identity.ownerId, 1, false, '.'), { command, timeout: 5, maxOutputChars: 1000 }, true, signal)
      const file = join(scratch, identity.ownerId, 'workspace/default/t.txt')
      assert.equal((await execute("sh -c 'rm t.txt'")).ok, false)
      assert.equal(await readFile(file, 'utf8'), 'line1\nline2\n')
      assert.equal((await execute('rm -rf /workspace/default')).ok, false)
      assert.equal((await execute('rm /personal/keep.txt')).ok, false)
      assert.equal((await execute('rm personal.txt')).ok, false)
      assert.equal(await readFile(personalFile, 'utf8'), 'keep\n')
      assert.equal((await execute('rm -rf t.txt')).ok, true)
      await assert.rejects(readFile(file), { code: 'ENOENT' })
      const files = createWorkspaceFileReads(pool, scratch)
      const [entry] = await files.listDiskTrash(identity.ownerId)
      assert.equal(entry?.relativePath, 't.txt')
      await files.restoreDiskTrash(identity.ownerId, entry!.id)
      assert.equal(await readFile(file, 'utf8'), 'line1\nline2\n')
    })
    await pool.query('UPDATE users SET is_active=FALSE WHERE id=$1', [identity.ownerId])
    const revoked = await dispatch({ id: 'revoked', name: 'shell', input: { command: 'pwd' } }, scope)
    assert.ok(revoked.kind === 'completed' && !revoked.successful)

    await t.test('网页确认动作经 Redis 写入恢复队列，模型收到真实 Shell 结果', {
      skip: !redisUrl && '需要隔离 Redis',
    }, async () => {
      await pool.query(`
        ALTER TABLE conversation_sessions ADD COLUMN execution_state text NOT NULL DEFAULT 'idle';
        ALTER TABLE agent_run_leases ADD COLUMN token text, ADD COLUMN fence bigint,
          ADD COLUMN created_at timestamptz, ADD COLUMN updated_at timestamptz, ADD PRIMARY KEY(user_id,session_id);
        ALTER TABLE agent_run_interaction_receipts ADD COLUMN created_at timestamptz, ADD PRIMARY KEY(user_id,session_id,run_id,receipt);
        ALTER TABLE agent_interaction_bindings ADD PRIMARY KEY(prompt_id);
        ALTER TABLE agent_interaction_resumes ADD COLUMN created_at timestamptz, ADD COLUMN completed_at timestamptz,
          ADD COLUMN claim_token text, ADD COLUMN claim_expires_at timestamptz, ADD PRIMARY KEY(user_id,session_id,run_id,prompt_id);
        ALTER TABLE interaction_prompts ADD COLUMN title text, ADD COLUMN body text, ADD COLUMN created_at timestamptz, ADD COLUMN resolved_at timestamptz;
        ALTER TABLE interaction_prompts ADD PRIMARY KEY(id);
        ALTER TABLE interaction_prompts ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
        ALTER TABLE interaction_actions ADD COLUMN id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
          ADD COLUMN token_hash text, ADD COLUMN consumed_at timestamptz, ADD COLUMN consumed_event_id text, ADD COLUMN created_at timestamptz;
        CREATE TABLE agent_run_startups(user_id uuid,session_id integer,run_id text,status text,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
        CREATE TABLE agent_run_checkpoints(user_id uuid,session_id integer,run_id text,version bigint,sequence bigint,status text,phase text,nonce bytea,payload bytea,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(user_id,session_id,run_id));
        CREATE TABLE agent_run_events(user_id uuid,session_id integer,run_id text,event_id text,sequence bigint,nonce bytea,payload bytea,created_at timestamptz,acknowledged_at timestamptz,PRIMARY KEY(user_id,session_id,run_id,event_id),UNIQUE(user_id,session_id,run_id,sequence));
      `)
      await pool.query('UPDATE users SET is_active=TRUE WHERE id=$1', [identity.ownerId])
      const store = createPostgresAgentRunStore<string[]>(pool, 'synthetic-run-key', { async writeHistory() {} })
      const queue = createPostgresInteractionResumeQueue(pool)
      const redis = createFilesystemAuthorizationConfirmationStore(createRedisFilesystemAuthorizationCommands(redisUrl!))
      const interactions = createPostgresInteractionActivator(pool, createAgentInteractionDescription(createTrustedPromptDescriptions({
        loadIntent: intents.loadIntent, createConfirmation: redis.createPending, filesystemAuthorizationEnabled: () => false,
      })))
      const respond = createAgentInteractionRespondService({
        pool, enqueue: createInteractionResumeEnqueuer(store),
        effects: {
          async applyCommandAction() { assert.fail('Shell 应由续轮工具执行') },
          async redeemConfirmation(_client, owner, code) { return redis.redeem(owner, code) },
        }, async wake() {}, diagnose() {},
      })
      async function exercise(sessionId: string, input: { command: string; scope?: 'system'; cwd?: string }, expectedStdout: string, expectedFile: string) {
        const nextIdentity = { ...identity, sessionId, runId: randomUUID() }
        const nextLease = { ...lease, identity: nextIdentity, token: randomUUID() }
        await pool.query('INSERT INTO conversation_sessions(id,user_id,workspace_id) VALUES ($2,$1,1)', [identity.ownerId, sessionId])
        await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,$4,$2,'selected',$3,1,CURRENT_TIMESTAMP+interval '5 minutes')", [identity.ownerId, nextIdentity.runId, nextLease.token, sessionId])
        const nextCall = { id: 'shell-resume', name: 'shell', input }
        const beforeConfirmation = await readFile(content, 'utf8')
        let providerRounds = 0
        const ports: AgentRunnerPorts<string[]> = {
          clock: { now: () => new Date().toISOString() },
          store, leases: createPostgresAgentRunLeasePort(pool),
          cancellation: { async isRequested() { return false }, async request() {}, async notify() {}, async subscribe() { return () => {} } },
          provider: { async *stream(request) {
            assert.equal(request.identity.runId, nextIdentity.runId)
            if (++providerRounds === 1) yield { type: 'complete', text: '', calls: [nextCall] }
            else {
              assert.partialDeepStrictEqual(JSON.parse(request.context.at(-1)!), { ok: true, stdout: expectedStdout, scope: input.scope ?? 'sandbox' })
              yield { type: 'complete', text: '完成', calls: [] }
            }
          } },
          context: {
            assertIdentity() {}, async checkpointToolResult(_scope, result) { return result },
            async restoreToolResult(_scope, result) { return result }, async prepare() { return ['prepared'] },
            async afterRound(value) { return value }, async resumeInteraction(value) { return value },
            async afterTool(value, call, result) { return call.id === nextCall.id && result.kind === 'completed'
              ? [...value, JSON.stringify(result.value)] : value },
            async recoverOverflow(value) { return { context: value, applied: false } },
            async afterUsage(value) { return { context: value, applied: false } }, async appendReminder(value) { return value },
          },
          tools: registryFor(nextLease).tools, interactions,
          execution: { async execute() { assert.fail('通用执行端口不应启动 Shell') } },
          reply: { async evaluate() { return 'accept' } }, sanitizeText: value => value,
          createStreamSanitizer: () => ({ feed: value => value, flush: () => '' }),
          presentError: () => ({ code: 'failed', text: '生成失败' }),
          async presentToolResult(value) { return value }, async publish() {}, diagnose() {},
        }
        const runner = createAgentRunner(ports)
        for await (const _event of runner.start(nextIdentity)) { /* 等待真实确认提示。 */ }
        assert.equal((await store.read(nextIdentity))?.status, 'waiting')
        const event = (await store.readEventsAfter(nextIdentity, 0)).find(value => value.type === 'interaction_required')
        assert.ok(event)
        const prompt = await createPostgresInteractionProjection(pool).interaction(event)
        const token = prompt.options.find(option => option.id === 'confirm')?.token
        assert.ok(token)
        assert.equal(await readFile(content, 'utf8'), beforeConfirmation)
        await assert.rejects(respond.respond(other, prompt.prompt_id, token))
        assert.equal((await respond.respond(identity.ownerId, prompt.prompt_id, token)).result.status, 'confirmed')
        await processOneInteraction({ queue, read: store.read, resume: runner.resume, invalidateCredential: async () => {}, diagnose() {} })
        assert.equal((await store.read(nextIdentity))?.status, 'completed')
        assert.equal(providerRounds, 2)
        assert.equal(await readFile(content, 'utf8'), expectedFile)
      }
      await exercise('2', { command: 'printf "resume\\n" | tee -a notes.txt 2>/dev/null' }, 'resume\n', 'owner\nconfirmed\nresume\n')
      adminSystemEnabled = true
      await writeFile(join(scratch, 'system-only.txt'), 'service-data\n')
      await exercise('3', { command: 'cat system-only.txt 2>/dev/null', cwd: scratch, scope: 'system' },
        'service-data\n', 'owner\nconfirmed\nresume\n')
    })
  } finally {
    await core.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(scratch, { recursive: true, force: true })
  }
})
