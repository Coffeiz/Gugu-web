import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID,createHash} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime,tablesSql} from '@gugu/core/data'
import {createSkillDeleteTool} from '../../../../packages/core/src/agent/tools/skill-management.js'
import type {ClientDeleteConfirmationPort} from '@gugu/core/tools'
import {createAuthorizedWebAgentProductionRagRunPorts} from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import {createUserSkillManager} from '../../../../packages/core/src/agent/skills/user-management.js'
import {createSkillManagementWriteTools} from '@gugu/core/tools'
import {createWebAgentConfirmationAuthorization} from '../../src/domains/agent-sessions/tools/agent-confirmation.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL
const a='00000000-0000-4000-8000-000000000061',b='00000000-0000-4000-8000-000000000062'
test('用户技能持久创建、owner隔离、序列并发和失败回滚',{skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`gugu_skill_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:3}),runtime=await createPostgresRuntime({url:url!,schema})
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,next_skill_sequence integer NOT NULL DEFAULT 1)')
  await pool.query("CREATE TABLE user_skills(id serial PRIMARY KEY,owner_id uuid NOT NULL,skill_id text NOT NULL,name text NOT NULL,description_short text NOT NULL,description_long text,category text NOT NULL,body text NOT NULL,related_tools json NOT NULL,source text NOT NULL,managed_by text NOT NULL,enabled boolean NOT NULL,content_digest text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(owner_id,skill_id))")
  await pool.query('INSERT INTO users(id) VALUES($1),($2)',[a,b]);const events:string[]=[]
  const manager=createUserSkillManager(runtime.db,'postgres',{knownTools:async()=>new Set(['web_search']),digest:text=>createHash('sha256').update(text).digest('hex').slice(0,16),publish:async owner=>{events.push(owner)}})
  const input={name:'合成',description_short:'摘要',description_long:null,category:'personal',body:'正文',related_tools:['web_search'],enabled:true}
  const [one,two]=await Promise.all([manager.create(a,input),manager.create(a,input)])
  assert.deepEqual(new Set([one.id,two.id]),new Set(['U1','U2']))
  const assistantSkill=await manager.create(a,{...input,name:'助理归纳',managed_by:'assistant'})
  assert.equal(assistantSkill.managed_by,'assistant')
  await assert.rejects(manager.update(b,one.id,{name:'越权'}));assert.equal((await manager.list(b)).length,0)
  await assert.rejects(manager.create(a,{...input,related_tools:['unknown']}));assert.equal((await pool.query('SELECT next_skill_sequence FROM users WHERE id=$1',[a])).rows[0].next_skill_sequence,4)
  const updated=await manager.update(a,one.id,{body:'更新正文',enabled:false});assert.equal(updated.body,'更新正文');assert.equal(updated.enabled,false)
  const assistantUpdated=await manager.update(a,assistantSkill.id,{body:'保留管理者'});assert.equal(assistantUpdated.managed_by,'assistant')
  const userTakeover=await manager.update(a,assistantSkill.id,{managed_by:'user',category:null});assert.equal(userTakeover.managed_by,'user');assert.equal(userTakeover.category,'personal')
  assert.equal((await manager.list(a)).length,3);assert.equal(events.length,6)
  await pool.query(tablesSql('postgres').receipts)
  const foreignSkill = await manager.create(b,{...input,managed_by:'assistant'})
  const automatic = await manager.create(a,{...input,managed_by:'assistant'})
  const identity = { ownerId:a, sessionId:'1', runId:'skill-delete' }
  const lease = { identity, token:'delete-lease', fence:1, mode:'start' as const, cancelRequested:false,
    input:{ userMessageId:1, locale:null, origin:null, accessVersion:'a'.repeat(64), v:2 as const, source:'web' as const } }
  let versionDigest: string | undefined
  let claims = 0, directChecks = 0, directAllowed = false
  const gate = {
    async prepare(toolCall: unknown, _scope: unknown, _digest: string, target: { versionsDigest: string }) {
      versionDigest = target.versionsDigest
      return { ok:true, value:{ id:'skill-confirm', kind:'confirmation', toolCall } }
    },
    async verify(_call: unknown, _scope: unknown, _digest: string, target: { versionsDigest: string }) {
      return target.versionsDigest === versionDigest ? { ok:true, value:{} } : { ok:false, code:'confirmation_rejected' }
    },
  } as unknown as ClientDeleteConfirmationPort['gate']
  const deleted: string[] = []
  const skillDelete = createSkillDeleteTool(runtime, {
    gate,
    async claim() { claims++; return true },
    async authorizeDirect(_tx, binding) {
      assert.equal(binding.toolName, 'delete_skill')
      assert.equal(binding.ownerId, a)
      directChecks++
      return directAllowed
    },
  }, async owner => { deleted.push(owner) })
  const options = {
    core:runtime, pool:{ async query() { return { rowCount:1, rows:[] } } } as never,
    storageRoot:'/synthetic', lease,
    selection:{ modelIdentity:'synthetic-model', contextScopeKey:lease.input.accessVersion,
      contextPolicy:{ loadOwnerContext:true, memoryEnabled:false } },
    enabled:async () => true,
  }
  const missingDelete = createAuthorizedWebAgentProductionRagRunPorts(options)
  assert.ok(!(await missingDelete.toolRegistry.capabilities(identity)).some(tool => tool.name === 'delete_skill'))
  const { toolRegistry } = createAuthorizedWebAgentProductionRagRunPorts({ ...options, skillDelete })
  assert.ok((await toolRegistry.capabilities(identity)).some(tool => tool.name === 'delete_skill'))
  const scope = { identity, roundId:'1', signal:new AbortController().signal, resolution:null,
    async execute(): Promise<never> { throw new Error('不应执行进程') } }
  const userCall = { id:'delete-user-skill', name:'delete_skill', input:{ id:one.id } }
  const resolution = { interactionId:'skill-confirm', receiptId:'test-receipt', status:'confirmed' as const, value:{} }
  assert.equal((await toolRegistry.tools.dispatch(userCall, scope)).kind, 'waiting')
  assert.ok((await manager.list(a)).some(skill => skill.id === one.id))
  await manager.update(a, one.id, {body:'确认后编辑'})
  const stale = await toolRegistry.tools.dispatch(userCall, { ...scope, resolution })
  assert.equal(stale.kind === 'completed' && stale.successful, false)
  assert.equal(claims, 0)
  assert.equal((await toolRegistry.tools.dispatch(userCall, scope)).kind, 'waiting')
  assert.equal((await toolRegistry.tools.dispatch(userCall, { ...scope, resolution })).kind === 'completed' && claims === 1, true)
  assert.ok(!(await manager.list(a)).some(skill => skill.id === one.id))
  const autoCall = { id:'delete-assistant-skill', name:'delete_skill', input:{ id:` ${automatic.id.toLowerCase()} ` } }
  const denied = await toolRegistry.tools.dispatch(autoCall, scope)
  assert.equal(denied.kind === 'completed' && denied.successful, false)
  assert.ok((await manager.list(a)).some(skill => skill.id === automatic.id))
  directAllowed = true
  const removed = await toolRegistry.tools.dispatch(autoCall, scope)
  assert.equal(removed.kind === 'completed' && removed.successful && removed.mutated, true)
  assert.equal(directChecks, 2)
  assert.equal(claims, 1)
  const replay = await toolRegistry.tools.reconcile(autoCall, { ...identity, roundId: scope.roundId })
  assert.equal(replay.kind === 'completed' && replay.successful && !replay.mutated, true)
  assert.deepEqual(deleted, [a,a])
  assert.ok((await manager.list(b)).some(skill => skill.id === foreignSkill.id))
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})

test('生产 Skill 写工具在同一 PostgreSQL 事务复核租约并持久恢复结果', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const schema = `gugu_skill_run_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY, next_skill_sequence int DEFAULT 1,
      security_version int DEFAULT 1, is_active boolean DEFAULT true, account_status text DEFAULT 'active');
      CREATE TABLE user_skills(id serial PRIMARY KEY, owner_id uuid, skill_id text, name text, description_short text,
        description_long text, category text, body text, related_tools json, source text, managed_by text, enabled boolean,
        content_digest text, created_at timestamptz, updated_at timestamptz, UNIQUE(owner_id, skill_id));
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY, user_id uuid, active_run_id text);
      CREATE TABLE agent_run_dispatch(user_id uuid, session_id integer, run_id text, state text, token text, fence bigint, lease_expires_at timestamptz);
      CREATE TABLE agent_run_leases(user_id uuid, session_id integer, run_id text, expires_at timestamptz);`)
    await pool.query(tablesSql('postgres').receipts)
    await pool.query('INSERT INTO users(id) VALUES ($1),($2)', [a, b])
    await pool.query("INSERT INTO conversation_sessions VALUES (1,$1,'skill-run')", [a])
    await pool.query("INSERT INTO agent_run_dispatch VALUES ($1,1,'skill-run','selected','run-token',1,now()+interval '5 minutes')", [a])
    await pool.query("INSERT INTO agent_run_leases VALUES ($1,1,'skill-run',now()+interval '5 minutes')", [a])
    const identity = { ownerId: a, sessionId: '1', runId: 'skill-run' }
    const accessVersion = 'a'.repeat(64)
    const lease = { identity, token: 'run-token', fence: 1, mode: 'start' as const, cancelRequested: false,
      input: { userMessageId: 1, locale: null, origin: null, accessVersion, v: 2 as const, source: 'web' as const } }
    let version = accessVersion, publications = 0, authorizationReads = 0, revokeOnRead = 0
    const manager = createUserSkillManager(runtime.db, 'postgres', {
      async knownTools() { return new Set(['web_search']) },
      digest: body => createHash('sha256').update(body).digest('hex'),
      async publish(owner) { assert.equal(owner, a); publications++ },
    })
    const authority = createWebAgentConfirmationAuthorization({ pool, lease, async accessVersion() {
      authorizationReads++
      return authorizationReads === revokeOnRead ? 'b'.repeat(64) : version
    } })
    const resources = () => createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool, lease, storageRoot: '/synthetic',
      selection: { modelIdentity: 'synthetic', contextScopeKey: accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      enabled: () => false,
      skillManagement: createSkillManagementWriteTools(runtime, manager, async (tx, candidate, signal) =>
        (await authority.authorizeInTransaction(tx, candidate, signal))?.endsWith(`:${accessVersion}`) === true),
    }).toolRegistry
    const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      async execute(): Promise<never> { throw new Error('不应执行进程') } }
    const toolRegistry = resources()
    const input = { skill_name: '合成技能', description_short: '简述', body: '不会写入收据的正文',
      related_tools: ['web_search'], managed_by: 'assistant' }
    const create = { id: 'create', name: 'create_skill', input }
    const attempts = await Promise.all([toolRegistry.tools.dispatch(create, scope), toolRegistry.tools.dispatch(create, scope)])
    assert.equal(attempts.filter(result => result.kind === 'completed' && result.successful && result.mutated).length, 1)
    assert.equal(attempts.every(result => result.kind === 'completed' && result.successful), true)
    const update = { id: 'edit', name: 'update_skill', input: { id: ' u1 ', enabled: false } }
    assert.equal((await toolRegistry.tools.dispatch(update, scope)).kind, 'completed')
    const recovered = await resources().tools.reconcile(update, { ...identity, roundId: scope.roundId })
    assert.ok(recovered.kind === 'completed' && recovered.successful && !recovered.mutated)
    assert.equal((await manager.list(a))[0]?.enabled, false)
    assert.equal(publications, 2)
    const altered = await resources().tools.reconcile({ ...update, input: { id: 'U1', enabled: true } }, { ...identity, roundId: scope.roundId })
    assert.ok(altered.kind === 'completed' && !altered.successful)
    const crossed = await toolRegistry.tools.dispatch(create, { ...scope, identity: { ...identity, ownerId: b } })
    assert.ok(crossed.kind === 'completed' && !crossed.successful)
    assert.equal((await manager.list(b)).length, 0)

    revokeOnRead = authorizationReads + 2
    const denied = await toolRegistry.tools.dispatch({ ...create, id: 'revoked' }, scope)
    assert.ok(denied.kind === 'completed' && !denied.successful)
    assert.equal((await manager.list(a)).length, 1)
    assert.equal((await pool.query('SELECT next_skill_sequence FROM users WHERE id=$1', [a])).rows[0].next_skill_sequence, 2)
    assert.equal(publications, 2)
    const receipts = await pool.query('SELECT method,result_json FROM core_operation_receipts ORDER BY method')
    assert.deepEqual(receipts.rows.map(row => row.method), ['agent.skill.create', 'agent.skill.update'])
    assert.doesNotMatch(JSON.stringify(receipts.rows), /不会写入收据的正文/u)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
