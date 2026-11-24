import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { RunIdentity } from '@gugu/core/agent'
import { databaseTime, initializeSqlite, openSqliteRuntime, SqlDataRuntime, type Database } from '@gugu/core/data'
import { createRedisScheduledTaskCommands } from '../../../src/adapters/cache/redis-events.js'
import { createWebScheduledTaskToolResources } from '../../../src/modules/scheduled-tasks/run/tools.js'
import { createScheduledTaskRunNowRuntime } from '../../../src/modules/scheduled-tasks/run/now.js'

function fakeRedis() {
  const values = new Map<string, { token: string; expires: number }>()
  return {
    async set(key: string, token: string, ...args: string[]) {
      if (args.includes('NX') && values.has(key)) return null
      const ttl = Number(args[args.indexOf('PX') + 1])
      values.set(key, { token, expires: Date.now() + ttl })
      return 'OK'
    },
    async eval(_script: string, _keys: number, key: string, token: string, ttl?: string) {
      const current = values.get(key)
      if (!current || current.token !== token) return 0
      if (ttl) { current.expires = Date.now() + Number(ttl); return 1 }
      values.delete(key)
      return 1
    },
    async exists(key: string) { return Number(values.has(key)) },
  }
}

test('Core SQLite and Redis lease runtime preserves trial, formal retry, failure and completion behavior', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-task-run-runtime-'))
  let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    opened = await openSqliteRuntime(path)
    const owner = opened.ownerId, storedOwner = owner.replaceAll('-', '')
    const time = databaseTime('2020-01-01T00:00:00.000000Z', 'sqlite')
    await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,start_at,channels,enabled,last_run_failed,created_at,updated_at)
      VALUES(810,${storedOwner},'普通任务','做一件事','*','cron',${time},'web',1,0,${time},${time})`.execute(opened.runtime.db)
    await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,start_at,channels,enabled,last_run_at,last_run_failed,created_at,updated_at)
      VALUES(811,${storedOwner},'失败一次性任务','做一件事','@once','once',${time},'web',1,${time},1,${time},${time})`.execute(opened.runtime.db)
    const future = databaseTime('2099-01-01T00:00:00.000000Z', 'sqlite')
    await sql`INSERT INTO scheduled_tasks(id,user_id,name,payload,cron,schedule_kind,start_at,channels,enabled,last_run_at,last_run_failed,created_at,updated_at)
      VALUES(812,${storedOwner},'未来日期失败任务','做一件事','@once','once',${future},'web',1,${time},1,${time},${time})`.execute(opened.runtime.db)
    const notifications: string[] = [], executions: boolean[] = []
    const db = opened.runtime.db
    await db.updateTable('scheduled_tasks').set({ channels: 'qq,feishu', delivery_targets: JSON.stringify({
      qq: { chat_type: 'group', chat_id: 'qq-group', channel_id: '1' },
      feishu: { chat_type: 'group', chat_id: 'feishu-group', channel_id: '2' },
    }) }).where('id', '=', 811).execute()
    const redis = fakeRedis()
    let disableOnAcquire = false
    const otherOwner = '00000000000040008000000000000099'
    let replaceOwnerOnAcquire = false
    const runNow = createScheduledTaskRunNowRuntime({
      db, backend: 'sqlite', waitSeconds: 1,
      redis: {
        ...redis,
        async set(...args) {
          const acquired = await redis.set(...args)
          if (acquired === 'OK' && disableOnAcquire)
            await db.updateTable('scheduled_tasks').set({ enabled: 0 }).where('id', '=', 810).execute()
          if (acquired === 'OK' && replaceOwnerOnAcquire)
            await db.updateTable('scheduled_tasks').set({ user_id: otherOwner }).where('id', '=', 811).execute()
          return acquired
        },
      },
      execution: {
        async attempt({ task, prompt, isTrial }) {
          assert.equal(task.ownerId, owner)
          assert.equal(task.payload, '做一件事')
          assert.match(prompt, /用户设置了一条定时任务：做一件事/)
          executions.push(isTrial)
          return { text: '## 执行结果', status: 'success', effects: 'none', files: [] }
        },
        async deliver(task, outcome) {
          assert.deepEqual(outcome, { text: '## 执行结果', status: 'success', files: [] })
          return task.id === '811' && executions.filter(value => !value).length === 1
            ? { 网页通知: '发送失败' }
            : { 网页通知: '已发送' }
        },
      },
      async notifyTasksChanged(ownerId) { notifications.push(ownerId) },
    })

    const trial = await runNow(owner, '810')
    assert.equal((await opened.runtime.db.selectFrom('scheduled_tasks').select(['last_run_at', 'last_run_failed']).where('id', '=', 810).executeTakeFirst())?.last_run_at, null)
    assert.deepEqual(trial, { ok: true, result: { 网页通知: '已发送' }, msg: '试运行结果：\n· 网页通知：已发送' })

    disableOnAcquire = true
    assert.deepEqual((await runNow(owner, '810')).result, { 错误: '任务不存在或已停用' })
    disableOnAcquire = false
    assert.deepEqual((await runNow(owner, '810')).result, { 错误: '任务不存在或已停用' })

    replaceOwnerOnAcquire = true
    assert.deepEqual((await runNow(owner, '811')).result, { 错误: '任务不存在或已停用' })
    const foreignTask = await db.selectFrom('scheduled_tasks').select(['last_run_at', 'last_run_failed']).where('id', '=', 811).executeTakeFirstOrThrow()
    assert.deepEqual(foreignTask, { last_run_at: time, last_run_failed: 1 })
    assert.deepEqual(executions, [true])
    replaceOwnerOnAcquire = false
    await db.updateTable('scheduled_tasks').set({ user_id: storedOwner }).where('id', '=', 811).execute()

    assert.deepEqual((await runNow(owner, '811')).result, { 错误: '一个定时任务目前只能设置一个群聊投递目标' })
    assert.deepEqual(await db.selectFrom('scheduled_tasks').select(['last_run_at', 'last_run_failed']).where('id', '=', 811).executeTakeFirstOrThrow(),
      { last_run_at: time, last_run_failed: 1 })
    assert.deepEqual(executions, [true])
    assert.deepEqual(notifications, [])
    await db.updateTable('scheduled_tasks').set({ channels: 'web' }).where('id', '=', 811).execute()

    const failed = await runNow(owner, '811')
    assert.equal((await opened.runtime.db.selectFrom('scheduled_tasks').select('last_run_failed').where('id', '=', 811).executeTakeFirst())?.last_run_failed, 1)
    assert.deepEqual(failed, { ok: true, result: { 网页通知: '发送失败' }, msg: '试运行结果：\n· 网页通知：发送失败' })

    await runNow(owner, '811')
    assert.equal(await opened.runtime.db.selectFrom('scheduled_tasks').select('id').where('id', '=', 811).executeTakeFirst(), undefined)
    await runNow(owner, '812')
    assert.equal(await opened.runtime.db.selectFrom('scheduled_tasks').select('id').where('id', '=', 812).executeTakeFirst(), undefined)
    assert.deepEqual(executions, [true, false, false, false])
    assert.deepEqual(notifications, [owner, owner, owner])
  } finally {
    await opened?.runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('定时执行复核工作区、文件系统授权和群聊归属', { skip: !pgUrl && '需要隔离 PostgreSQL' }, async () => {
  const owner = randomUUID()
  const other = randomUUID()
  const schema = `test_run_workspace_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const pool = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
  const storageRoot = await mkdtemp(join(tmpdir(), 'gugu-scheduled-group-'))
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE scheduled_tasks(id integer PRIMARY KEY,user_id uuid,name text,payload text,
      schedule_kind text,start_at timestamptz,end_at timestamptz,channels text,enabled boolean,last_run_at timestamptz,
      last_run_failed boolean,updated_at timestamptz,delivery_targets jsonb,authorized_tools jsonb,email_attachment_file_paths jsonb,
      workspace_id integer,filesystem_authorization_grant_id integer,event_id integer,execution_mode text NOT NULL DEFAULT 'instruction');
      CREATE TABLE calendar_events(id integer PRIMARY KEY,user_id uuid,title text,date date,time text,deleted_at timestamptz);
      CREATE TABLE workspaces(id integer PRIMARY KEY,user_id uuid,name text,kind text,enabled boolean,
      directory_id integer,project_id integer);
      CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,directory_name text,deleted_at timestamptz);
      CREATE TABLE filesystem_authorization_grants(id integer PRIMARY KEY,user_id uuid,subject_type text,subject_id text,
        scope text,permission text,revoked_at timestamptz,expires_at timestamptz);
      CREATE TABLE user_bots(id integer PRIMARY KEY,user_id uuid,platform text,enabled boolean,group_memory_enabled boolean NOT NULL DEFAULT TRUE,
        group_chat_enabled boolean NOT NULL DEFAULT TRUE,feishu_group_chat_enabled boolean);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,source text,bot_id text,chat_type text,chat_id text);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,role text,content text,content_json jsonb,
        conversation_seq integer,platform_user_id text,platform_user_name text,created_at timestamptz);
      CREATE TABLE memory_scope_tombstones(owner_user_id uuid,platform text,bot_id text,scope_type text,scope_id text);
      CREATE TABLE memory_reflection_cursors(id serial PRIMARY KEY,owner_user_id uuid,platform text,bot_id text,scope_type text,
        scope_id text,scope_version integer,updated_at timestamptz);
      CREATE TABLE user_skills(owner_id uuid,skill_id text,name text,description_short text,category text,related_tools jsonb,
        managed_by text,enabled boolean,source text,body text,content_digest text,PRIMARY KEY(owner_id,skill_id))`)
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,name,payload,schedule_kind,start_at,channels,enabled,last_run_at,last_run_failed,workspace_id)
      VALUES(1,$1,'失效绑定','检查事项','once','2020-01-01T00:00:00Z','web',TRUE,'2020-01-01T00:00:00Z',TRUE,7)`, [owner])
    await pool.query(`INSERT INTO workspaces(id,user_id,name,kind,enabled,directory_id)
      VALUES(7,$1,'合成工作区','directory',TRUE,8)`, [owner])
    await pool.query(`INSERT INTO workspace_directories VALUES(8,$1,'workspace-synthetic',NOW())`, [owner])
    await pool.query(`INSERT INTO user_skills VALUES
      ($1,'U1','合成技能','说明','测试','["group_context_search","delete_scheduled_task"]','user',TRUE,'user','当前用户技能正文','synthetic-digest'),
      ($2,'U1','其他技能','说明','测试','[]','user',TRUE,'user','其他用户技能正文','synthetic-foreign-digest')`, [owner, other])
    let executions = 0
    let deliveries = 0
    let filesystemEnabled = true
    const grants: Array<number | null> = []
    const groupScopes: unknown[] = []
    const prompts: string[] = []
    let deleteMemoryDuringAttempt = false
    let verifyGroupSearch = false
    const groupResources = createWebScheduledTaskToolResources({
      core: new SqlDataRuntime(db, 'postgres'), now: () => new Date(), timezone: async () => 'UTC',
      skillCatalog: { builtins: [], fingerprint: id => `synthetic:${id}` },
    })
    const run = createScheduledTaskRunNowRuntime({
      db, backend: 'postgres', redis: fakeRedis(), waitSeconds: 10,
      filesystemAuthorizationEnabled: () => filesystemEnabled,
      storageRoot,
      execution: {
        async attempt({ task, prompt, toolsForRun, assertLease }) {
          executions++
          if (task.id === '1') assert.equal(task.workspaceId, 7)
          grants.push(task.filesystemGrantId)
          groupScopes.push(task.groupScope)
          prompts.push(prompt)
          if (verifyGroupSearch) {
            verifyGroupSearch = false
            assert.ok(assertLease)
            const identity = { ownerId: owner, sessionId: `scheduled-task:${task.id}`, runId: randomUUID() }
            const { tools, preparation } = await groupResources({ identity, task, assertLease, additionalReadTools: toolsForRun?.(identity) })
            const signal = new AbortController().signal
            const configuration = await preparation.configuration(identity, signal)
            const exposesGroupSearch = async () =>
              (await preparation.discover(configuration, signal)).some(item => item.name === 'group_context_search')
            const exposesMemorySearch = async () =>
              (await preparation.discover(configuration, signal)).some(item => item.name === 'search_memory')
            assert.equal(await exposesGroupSearch(), true)
            assert.equal(await exposesMemorySearch(), true)
            const scope = { identity, signal: new AbortController().signal, roundId: '1', resolution: null,
              async execute(): Promise<never> { throw new Error('群聊搜索不执行进程') } }
            const search = (candidate: RunIdentity = identity) => tools.dispatch({
              id: 'synthetic-group-query', name: 'group_context_search', input: { queries: ['部署', '完成'], mode: 'AND', speaker: '值班同学' },
            }, { ...scope, identity: candidate })
            const searchMemory = (input: Record<string, unknown> = { query: '群资料' }, candidate: RunIdentity = identity) => tools.dispatch({
              id: 'synthetic-memory-query', name: 'search_memory', input,
            }, { ...scope, identity: candidate })
            const useSkill = () => tools.dispatch({ id: 'synthetic-use-skill', name: 'use_skill', input: { id: 'U1' } }, scope)
            const skill = await useSkill()
            assert.ok(skill.kind === 'completed' && skill.successful)
            assert.match(JSON.stringify(skill.value), /当前用户技能正文/u)
            assert.doesNotMatch(JSON.stringify(skill.value), /其他用户技能正文/u)
            assert.match(JSON.stringify(skill.canonicalEvents), /group_context_search/u)
            assert.doesNotMatch(JSON.stringify(skill.canonicalEvents), /delete_scheduled_task/u)
            await pool.query("UPDATE user_skills SET enabled=FALSE WHERE owner_id=$1 AND skill_id='U1'", [owner])
            const revoked = await useSkill()
            assert.ok(revoked.kind === 'completed' && !revoked.successful)
            const found = await search()
            assert.equal(found.kind, 'completed')
            assert.equal(found.successful, true)
            assert.deepEqual(found.value, { keyword: '', queries: ['部署', '完成'], mode: 'AND', speaker: '值班同学',
              speaker_id: 'member-1', messages: [{ role: '用户', content: '部署完成', platform_user_id: 'member-1', platform_user_name: '小北' }] })
            const memory = await searchMemory()
            assert.ok(memory.kind === 'completed' && memory.successful)
            assert.match(JSON.stringify(memory.value), /本群资料/u)
            assert.doesNotMatch(JSON.stringify(memory.value), /异主范围|异 Bot 范围|异群范围/u)
            for (const requestedScope of ['private_memory', 'all_my_groups']) {
              const deniedMemory = await searchMemory({ query: '群资料', scope: requestedScope })
              assert.ok(deniedMemory.kind === 'completed' && !deniedMemory.successful)
            }
            for (const candidate of [{ ...identity, ownerId: other }, { ...identity, runId: 'foreign-run' }]) {
              const denied = await search(candidate)
              assert.ok(denied.kind === 'completed' && !denied.successful)
              const deniedMemory = await searchMemory({ query: '群资料' }, candidate)
              assert.ok(deniedMemory.kind === 'completed' && !deniedMemory.successful)
            }
            await pool.query('UPDATE user_bots SET group_memory_enabled=FALSE WHERE id=5')
            assert.equal(await exposesGroupSearch(), true)
            assert.equal(await exposesMemorySearch(), false)
            const memoryDisabled = await searchMemory()
            assert.ok(memoryDisabled.kind === 'completed' && !memoryDisabled.successful)
            await pool.query('UPDATE user_bots SET group_memory_enabled=TRUE WHERE id=5')
            await pool.query('UPDATE user_bots SET enabled=FALSE WHERE id=5')
            assert.equal(await exposesGroupSearch(), false)
            assert.equal(await exposesMemorySearch(), false)
            const disabled = await search()
            assert.ok(disabled.kind === 'completed' && !disabled.successful)
            const disabledMemory = await searchMemory()
            assert.ok(disabledMemory.kind === 'completed' && !disabledMemory.successful)
            await pool.query('UPDATE user_bots SET enabled=TRUE WHERE id=5')
            assert.equal(await exposesGroupSearch(), true)
            assert.equal(await exposesMemorySearch(), true)
            await pool.query("UPDATE scheduled_tasks SET channels='web' WHERE id=3")
            assert.equal(await exposesGroupSearch(), false)
            const removed = await search()
            assert.ok(removed.kind === 'completed' && !removed.successful)
            const removedMemory = await searchMemory()
            assert.ok(removedMemory.kind === 'completed' && !removedMemory.successful)
            await pool.query("UPDATE scheduled_tasks SET channels='qq' WHERE id=3")
          }
          if (deleteMemoryDuringAttempt) {
            deleteMemoryDuringAttempt = false
            await pool.query("INSERT INTO memory_scope_tombstones VALUES($1,'qq','5','group','group-synthetic')", [owner])
            return { text: '上游失败', status: 'failed', effects: 'none', files: [] }
          }
          return { text: '结果', status: 'success', effects: 'none', files: [] }
        },
        async deliver() { deliveries++; return { 网页通知: '已发送' } },
      },
      async notifyTasksChanged() {},
    })
    const expected = { 错误: '任务工作区不可用，已跳过执行' }
    assert.deepEqual((await run(owner, '1')).result, expected)
    await pool.query('UPDATE workspace_directories SET deleted_at=NULL,user_id=$1 WHERE id=8', [other])
    assert.deepEqual((await run(owner, '1')).result, expected)
    await pool.query('UPDATE workspace_directories SET user_id=$1 WHERE id=8', [owner])
    await pool.query('UPDATE workspaces SET enabled=FALSE WHERE id=7')
    assert.deepEqual((await run(owner, '1')).result, expected)
    assert.equal(executions, 0)
    assert.equal(deliveries, 0)
    assert.deepEqual((await pool.query('SELECT last_run_at,last_run_failed FROM scheduled_tasks WHERE id=1')).rows,
      [{ last_run_at: new Date('2020-01-01T00:00:00Z'), last_run_failed: true }])
    await pool.query('UPDATE workspaces SET enabled=TRUE WHERE id=7')
    assert.deepEqual((await run(owner, '1')).result, { 网页通知: '已发送' })
    assert.equal(executions, 1)
    assert.equal(deliveries, 1)

    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,name,payload,schedule_kind,channels,enabled,filesystem_authorization_grant_id)
      VALUES(2,$1,'授权任务','检查事项','cron','web',TRUE,9)`, [owner])
    await pool.query(`INSERT INTO filesystem_authorization_grants VALUES(9,$1,'scheduled_task','2','user_sandbox','read_write',NULL,NULL),
      (10,$1,'scheduled_task','2','user_sandbox','read_write',NULL,NULL)`, [owner])
    const expectGrant = async (grant: number | null) => {
      assert.deepEqual((await run(owner, '2')).result, { 网页通知: '已发送' })
      assert.equal(grants.at(-1), grant)
    }
    await expectGrant(9)
    await pool.query('UPDATE filesystem_authorization_grants SET revoked_at=NOW() WHERE id=9')
    await expectGrant(null)
    await pool.query("UPDATE filesystem_authorization_grants SET revoked_at=NULL,expires_at=NOW()-INTERVAL '1 day' WHERE id=9")
    await expectGrant(null)
    await pool.query("UPDATE filesystem_authorization_grants SET expires_at=NULL,subject_id='1' WHERE id=9")
    await expectGrant(null)
    await pool.query("UPDATE filesystem_authorization_grants SET subject_id='2',user_id=$1 WHERE id=9", [other])
    await expectGrant(null)
    await pool.query("UPDATE filesystem_authorization_grants SET user_id=$1,subject_type='session' WHERE id=9", [owner])
    await expectGrant(null)
    await pool.query("UPDATE filesystem_authorization_grants SET subject_type='scheduled_task',permission='read_only' WHERE id=9")
    await expectGrant(null)
    await pool.query("UPDATE filesystem_authorization_grants SET permission='read_write',scope='workspace' WHERE id=9")
    await expectGrant(null)
    await pool.query("UPDATE filesystem_authorization_grants SET scope='user_sandbox' WHERE id=9")
    filesystemEnabled = false
    await expectGrant(null)
    filesystemEnabled = true
    await pool.query("INSERT INTO calendar_events VALUES(1,$1,'合成事件','2026-01-01',NULL,NULL)", [owner])
    await pool.query('UPDATE scheduled_tasks SET event_id=1 WHERE id=2')
    await expectGrant(null)
    await pool.query('UPDATE scheduled_tasks SET event_id=NULL,filesystem_authorization_grant_id=NULL WHERE id=2')
    await expectGrant(null)

    const group = { chat_type: 'group', channel_id: '5', chat_id: 'group-synthetic' }
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,name,payload,schedule_kind,channels,enabled,delivery_targets)
      VALUES(3,$1,'群提醒','检查事项','cron','qq',TRUE,$2)`, [owner, JSON.stringify({ qq: group })])
    await pool.query("INSERT INTO user_bots(id,user_id,platform,enabled) VALUES(5,$1,'qq',TRUE),(6,$1,'qq',TRUE)", [owner])
    await pool.query("INSERT INTO conversation_sessions VALUES(1,$1,'qq','5','group','group-synthetic')", [other])
    async function writeSummary(scopeOwner: string, botId: string, groupId: string, text: string) {
      const root = join(storageRoot, scopeOwner, '.agent', 'memories', 'im', 'qq', botId, 'groups', groupId)
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'summary.json'), JSON.stringify({ text }))
      return root
    }
    const groupRoot = await writeSummary(owner, '5', 'group-synthetic', '本群概要')
    await writeFile(join(groupRoot, 'profile.json'), JSON.stringify([{ text: '本群资料' }]))
    await writeFile(join(groupRoot, 'daily.md'), '不注入每日记忆')
    await writeFile(join(groupRoot, 'members.json'), JSON.stringify({ members: { 'member-1': { name: '小北', aliases: ['值班同学'] } } }))
    await writeSummary(other, '5', 'group-synthetic', '异主范围')
    await writeSummary(owner, '6', 'group-synthetic', '异 Bot 范围')
    await writeSummary(owner, '5', 'another-group', '异群范围')

    const before = executions
    const beforeDeliveries = deliveries
    const denied = { 错误: '任务群聊目标不可用，已跳过执行' }
    assert.deepEqual((await run(owner, '3')).result, denied)
    await pool.query("UPDATE conversation_sessions SET user_id=$1,bot_id='6'", [owner])
    assert.deepEqual((await run(owner, '3')).result, denied)
    await pool.query("UPDATE conversation_sessions SET bot_id='5'")
    await pool.query('UPDATE user_bots SET enabled=FALSE WHERE id=5')
    assert.deepEqual((await run(owner, '3')).result, denied)
    await pool.query('UPDATE user_bots SET enabled=TRUE WHERE id=5')
    await pool.query('UPDATE scheduled_tasks SET delivery_targets=$1 WHERE id=3',
      [JSON.stringify({ qq: { ...group, platform: 'feishu' } })])
    assert.deepEqual((await run(owner, '3')).result, denied)
    await pool.query('UPDATE scheduled_tasks SET delivery_targets=$1 WHERE id=3', [JSON.stringify({ qq: group })])
    assert.equal(executions, before)
    assert.equal(deliveries, beforeDeliveries)

    await pool.query(`INSERT INTO conversation_sessions VALUES
      (2,$1,'qq','5','group','group-synthetic'),(3,$2,'qq','6','group','group-synthetic'),
      (4,$2,'qq','5','group','another-group'),(5,$2,'feishu','5','group','group-synthetic')`, [other, owner])
    await pool.query(`INSERT INTO conversation_messages VALUES
      (1,1,'user','部署完成',NULL,1,'member-1','小北',NOW()),(2,1,'user','计划部署',NULL,2,'member-1','小北',NOW()),
      (3,2,'user','异主部署完成',NULL,3,'member-1','小北',NOW()),(4,3,'user','异 Bot 部署完成',NULL,4,'member-1','小北',NOW()),
      (5,4,'user','异群部署完成',NULL,5,'member-1','小北',NOW()),(6,5,'user','异平台部署完成',NULL,6,'member-1','小北',NOW()),
      (7,1,'user','结构化部署完成','{}',7,'member-1','小北',NOW())`)
    await pool.query("UPDATE scheduled_tasks SET channels='qq,telegram' WHERE id=3")
    await pool.query('UPDATE scheduled_tasks SET delivery_targets=$1 WHERE id=3',
      [JSON.stringify({ qq: group, telegram: { chat_type: 'c2c', channel_id: '7', puid: 'synthetic-private' } })])
    await pool.query('UPDATE user_bots SET group_memory_enabled=FALSE WHERE id=5')
    assert.deepEqual((await run(owner, '3')).result, { 网页通知: '已发送' })
    assert.ok(groupScopes.at(-1))
    assert.doesNotMatch(prompts.at(-1)!, /本群概要|本群资料/u)
    await pool.query('UPDATE user_bots SET group_memory_enabled=TRUE WHERE id=5')
    verifyGroupSearch = true
    assert.deepEqual((await run(owner, '3')).result, { 网页通知: '已发送' })
    assert.deepEqual(groupScopes.at(-1), { ownerId: owner, platform: 'qq', botId: '5', scopeType: 'group', scopeId: 'group-synthetic' })
    assert.match(prompts.at(-1)!, /^## 当前群组记忆（仅限本群公开信息）\n\n### 群组 summary\n本群概要\n\n### 群组 profile\n- 本群资料\n\n\[定时任务触发：群提醒\]/u)
    assert.doesNotMatch(prompts.at(-1)!, /异主范围|异 Bot 范围|异群范围|不注入每日记忆/u)
    await writeFile(join(groupRoot, 'profile.json'), JSON.stringify(
      Array.from({ length: 51 }, (_, index) => ({ text: `群资料条目 ${index + 1}。` })),
    ))
    await run(owner, '3')
    assert.match(prompts.at(-1)!, /群资料条目 50。/u)
    assert.doesNotMatch(prompts.at(-1)!, /群资料条目 51。/u)
    await writeFile(join(groupRoot, 'summary.json'), JSON.stringify({ text: '𠮷'.repeat(3_001) }))
    await run(owner, '3')
    assert.ok(prompts.at(-1)!.includes(`### 群组 summary\n${'𠮷'.repeat(3_000)}\n\n[定时任务`))
    assert.doesNotMatch(prompts.at(-1)!, /群资料条目|�/u)

    await writeSummary(owner, '5', 'group-synthetic', '本群概要')
    deleteMemoryDuringAttempt = true
    assert.deepEqual((await run(owner, '3')).result, { 网页通知: '已发送' })
    assert.match(prompts.at(-2)!, /本群概要/u)
    assert.doesNotMatch(prompts.at(-1)!, /本群概要|群资料条目/u)
    await pool.query("UPDATE scheduled_tasks SET channels='web' WHERE id=3")
    assert.deepEqual((await run(owner, '3')).result, { 网页通知: '已发送' })
    assert.equal(groupScopes.at(-1), undefined)
  } finally {
    await db.destroy()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally {
      await admin.end()
      await rm(storageRoot, { recursive: true, force: true })
    }
  }
})

const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('实际 Redis 租约在模型返回前被接管时，旧任务不投递且不能释放新锁', { skip: !redisUrl && '需要隔离 Redis' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-scheduled-redis-'))
  const redis = createRedisScheduledTaskCommands(redisUrl!)
  let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  const id = 1 + Number.parseInt(randomUUID().slice(0, 7), 16)
  const key = `scheduled:lock:${id}`, replacement = randomUUID()
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    opened = await openSqliteRuntime(path)
    const { ownerId, runtime: { db } } = opened
    const time = databaseTime('2026-01-01T00:00:00.000000Z', 'sqlite')
    await db.insertInto('scheduled_tasks').values({
      id, user_id: ownerId.replaceAll('-', ''), name: '合成任务', payload: '合成指令', cron: '0 0 * * *',
      schedule_kind: 'cron', channels: 'web', enabled: 1, delivery_targets: '{}', authorized_tools: '[]', email_attachment_file_paths: '[]',
      created_at: time, updated_at: time,
    }).execute()
    let attempts = 0
    const run = createScheduledTaskRunNowRuntime({
      db, backend: 'sqlite', redis, async notifyTasksChanged() {},
      execution: {
        async attempt() {
          attempts++
          assert.equal(await redis.set(key, replacement, 'PX', '5000', 'XX'), 'OK')
          return { text: '过期运行的结果', status: 'success', effects: 'none', files: [] }
        },
        async deliver() { assert.fail('失去租约的任务不能投递') },
      },
    })
    assert.deepEqual((await run(ownerId, String(id))).result, { 错误: '任务执行租约已失效，请稍后重试' })
    assert.equal(attempts, 1)
    assert.equal(await redis.eval("return redis.call('GET',KEYS[1])", 1, key), replacement)
  } finally {
    try {
      await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, replacement)
    } finally {
      await opened?.runtime.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
})


test('定时任务通过任务租约发现并调用共享工具，拒绝异次执行和停用任务', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-scheduled-tools-'))
  let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    opened = await openSqliteRuntime(path)
    const { ownerId, runtime } = opened, db = runtime.db
    const time = databaseTime('2026-01-01T00:00:00.000000Z', 'sqlite')
    const id = 716
    await db.insertInto('scheduled_tasks').values({
      id, user_id: ownerId.replaceAll('-', ''), name: '当前用户的例行汇报', payload: '查看定时任务', cron: '0 0 * * *',
      schedule_kind: 'cron', channels: 'web', enabled: 1, delivery_targets: '{}',
      // 已保存授权不能让定时任务取得尚未接通的交互式删除权限。
      authorized_tools: '["delete_scheduled_task"]', email_attachment_file_paths: '[]',
      created_at: time, updated_at: time,
    }).execute()
    const resources = createWebScheduledTaskToolResources({
      core: runtime,
      now: () => new Date('2026-01-01T08:00:00Z'),
      timezone: async () => 'Asia/Shanghai',
    })
    const run = createScheduledTaskRunNowRuntime({
      db, backend: 'sqlite', redis: fakeRedis(), async notifyTasksChanged() {},
      execution: {
        async attempt({ task, assertLease }) {
          assert.ok(assertLease)
          const identity = { ownerId, sessionId: `scheduled-task:${id}`, runId: randomUUID() }
          const { tools, preparation } = await resources({ identity, task, assertLease })
          const signal = new AbortController().signal
          const configuration = await preparation.configuration(identity, signal)
          assert.deepEqual(configuration.identity.subject, { kind: 'scheduled_task', id: String(id) })
          const definitions = await preparation.discover(configuration, signal)
          const names = definitions.map(tool => tool.name)
          assert.ok(names.includes('get_current_time') && names.includes('list_scheduled_tasks'))
          assert.ok(!names.includes('delete_scheduled_task') && !names.includes('ask_user'))
          const invoke = (name: string, candidate: RunIdentity = identity) => tools.dispatch({ name, id: name, input: {} }, {
            identity: candidate, signal, roundId: '1', resolution: null,
            async execute() { assert.fail('只读工具不执行进程') },
          })
          const current = await invoke('get_current_time')
          assert.ok(current.kind === 'completed' && current.successful && current.value
            && typeof current.value === 'object' && 'time' in current.value && current.value.time === '16:00:00')
          const listing = await invoke('list_scheduled_tasks')
          assert.ok(listing.kind === 'completed' && listing.successful && JSON.stringify(listing.value).includes('当前用户的例行汇报'))
          for (const candidate of [{ ...identity, ownerId: randomUUID() }, { ...identity, runId: 'other-run' }]) {
            const rejected = await invoke('list_scheduled_tasks', candidate)
            assert.ok(rejected.kind === 'completed' && !rejected.successful)
          }
          await db.updateTable('scheduled_tasks').set({ enabled: 0 }).where('id', '=', id).execute()
          const denied = await invoke('list_scheduled_tasks')
          assert.ok(denied.kind === 'completed' && !denied.successful && denied.executed === false)
          return { text: '已验证工具权限', status: 'success', effects: 'none', files: [] }
        },
        async deliver(_task, outcome) { return { 网页通知: outcome.text } },
      },
    })
    assert.deepEqual((await run(ownerId, String(id))).result, { 网页通知: '已验证工具权限' })
  } finally {
    await opened?.runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('HTTP 等待超时后，Host 关闭仍等待定时投递和租约释放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-scheduled-drain-'))
  let opened: Awaited<ReturnType<typeof openSqliteRuntime>> | undefined
  let complete!: () => void
  const gate = new Promise<void>(resolve => { complete = resolve })
  try {
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    opened = await openSqliteRuntime(path)
    const { ownerId, runtime: { db } } = opened
    const time = databaseTime('2026-01-01T00:00:00.000000Z', 'sqlite')
    await db.insertInto('scheduled_tasks').values({
      id: 743, user_id: ownerId.replaceAll('-', ''), name: '等待运行', payload: '合成指令', cron: '0 0 * * *',
      schedule_kind: 'cron', channels: 'web', enabled: 1, delivery_targets: '{}',
      authorized_tools: '[]', email_attachment_file_paths: '[]', created_at: time, updated_at: time,
    }).execute()
    const redis = fakeRedis()
    let delivered = false, drained = false
    const run = createScheduledTaskRunNowRuntime({
      db, backend: 'sqlite', redis, waitSeconds: 0.02, async notifyTasksChanged() {},
      execution: {
        async attempt() { await gate; return { text: '合成报告', status: 'success', effects: 'none', files: [] } },
        async deliver() { delivered = true; return { 网页通知: '已发送' } },
      },
    })
    const result = await run(ownerId, '743')
    assert.equal(result.pending, true)
    const closing = run.drain().then(() => { drained = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(drained, false)
    assert.equal(delivered, false)
    complete()
    await closing
    assert.equal(delivered, true)
    assert.equal(await redis.exists('scheduled:lock:743'), 0)
  } finally {
    complete()
    await opened?.runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})
