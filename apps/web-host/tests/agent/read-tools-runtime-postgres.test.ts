import { createNoteLifecyclePort } from '@gugu/core/tools'
import { createCanvasCreationPort, createCanvasEditPort } from '@gugu/core/tools'
import { createAgentPlaceableSearch } from '@gugu/core/mind'
import { createBuiltinSkillDefinitions, createSkillMetadataReader } from '@gugu/core/skills'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createKyselyDashboardCounter, createAgentWorkspaceQueries, dataContext } from '@gugu/core'
import { createKyselyAgentWorkspaceReader, createPostgresRuntime } from '@gugu/core/data'
import type { SqlDataRuntime } from '@gugu/core/data'
import { createCanonicalSourceLoader, stableJson } from '@gugu/core/agent'
import type { CanonicalContextPorts, CanonicalRunContext, AgentRunnerPorts, RunCheckpoint, RunEvent } from '@gugu/core/agent'
import { createDurableProjectMutationPort, createWorkspaceMutationPort } from '@gugu/core/tools'
import { createAgentCalendarReader, createKyselyCalendarAgentReadPort } from '@gugu/core/calendar'
import { mkdtemp, mkdir, rename, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createPostgresProjectUpdateRuntime } from '../../src/domains/projects/persistence/project-update-postgres.js'
import { ProviderStreamSanitizer, stripThinking } from '@gugu/core/providers'
import { createAgentMindReader, createSqlMindCanvasReader } from '@gugu/core/mind'
import { tablesSql } from '../../../../packages/core/src/data/schema.js'
import { createAgentRuntime } from '../../src/domains/agent-sessions/agent-runtime.js'
import { createAgentToolRegistry } from '../../src/domains/agent-sessions/tools/agent-tool-registry.js'
import { agentContextAccessScope } from '../../src/domains/agent-config/access-scope.js'
import { bindProviderSelection } from '../../src/domains/agent-config/provider-resolver.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
type RuntimePorts = Omit<AgentRunnerPorts<CanonicalRunContext>, 'context' | 'execution' | 'reply' | 'provider'>

/** Provider、RunStore、lease、授权、上下文源均为替身；Host runtime/registry/Provider adapter/Core仓储/PG为真实实现。 */
async function runReadRound(core: SqlDataRuntime, ownerId: string, timezone: string, reject = false, custom?: {
  registry: ReturnType<typeof createAgentToolRegistry>
  names: string[]
  calls: Array<{ id: string; name: string; input: unknown }>
}) {
  const identity = { ownerId, sessionId: '1', runId: randomUUID() }
  const allowed = new Set(['list_clients', 'list_projects', 'get_current_time', 'create_project'])
  const registry = custom?.registry ?? createAgentToolRegistry({ core,
    authorize: async (scope, name) => scope.ownerId === ownerId && allowed.has(name),
    time: { now: () => new Date('2026-01-01T20:00:00Z'), timezone: async scope => { assert.equal(scope.ownerId, ownerId); return timezone } },
  })
  const policy = { groupChat: false, contextPolicy: { loadOwnerContext: true, memoryEnabled: true } }
  const access = agentContextAccessScope('synthetic-read-tools-secret', identity, policy, { permissions: '1', model: '1', credentials: '1' }, digest, 'owner')
  const bound = await bindProviderSelection(identity, {
    selectPlatformModel: async () => ({ config: { provider: 'openai', model: 'synthetic' }, systemPrompt: '合成系统', byokEnabled: false, localDeployment: false, accessScopeHash: access.accessScopeHash }),
    readActiveCredential: async () => null, decryptCredential: () => { throw new Error('只读替身不读取凭据') }, defaultBaseUrl: () => '',
  }, new AbortController().signal)
  const source = createCanonicalSourceLoader({ digest, nextId: randomUUID, now: () => 0,
    readSnapshot: async () => ({ ...identity, contextEpoch: 0, context: null, snapshotHash: null, sessionInfoHash: null, snapshotExpiresAt: null, baselineMessageSeq: 0 }),
    select: async () => ({ ...policy, modelIdentity: bound.modelIdentity, contextWindow: 10000, locale: 'zh-CN', workspaceBinding: null, contextScopeKey: access.contextScopeKey }),
    currentRevision: async () => 0, historyReader: { read: async () => ({ baselineSeq: 0, rows: [] }) },
    currentTurn: async () => ({ currentUser: { persistedMessageId: '1', message: { role: 'user', content: '请查询联系人、项目和当前时间。' } } }),
    data: { loadTimezone: async () => timezone, loadProjects: async () => [], loadEvents: async () => [], loadNotes: async () => [], loadFilesOverview: async () => ({}), loadStylePreferences: async () => ({}), loadImChannels: async () => ({}), loadMemory: async () => ({}), loadImMemory: async () => ({}), loadKnowledge: async () => [] },
    builder: { buildSnapshot: () => ({ systemPrompt: '系统', snapshotContext: '合成快照', sessionInfo: {}, userTimezone: timezone }), buildRequest: () => ({ systemPrompt: '系统', systemInMessages: false, fixedPrefix: [] }) },
  })
  const context: CanonicalContextPorts = {
    digest, nextId: randomUUID,
    load: async (id, signal) => { const tools = await registry.capabilities(id); return { ...await source.load(id, signal), capabilities: { toolNames: tools.map(tool => tool.name), tools } } },
    preparation: { buildRag: async () => ({ tail: [] }) },
    // 此端口只提供非持久前缀/动态尾部；工具结果必须由真实Canonical prepared.area恢复进入wire。
    prepareRequest: async () => ({ prefix: [], dynamicTail: [] }),
    references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
    compaction: { summarize: async () => { throw new Error('只读轮不应压缩') } }, finalization: { complete: async () => {} }, currentRequest: () => null,
    stageContinuation: async () => { throw new Error('不应启动续接') }, releaseContinuations: async () => {}, diagnoseCompactionFailure: () => {},
  }
  let checkpoint: RunCheckpoint<CanonicalRunContext> | null = null
  const outbox: RunEvent[] = [], committedToolResults: unknown[] = []
  const runtime: RuntimePorts = {
    clock: { now: () => '2026-01-01T20:00:00Z' },
    store: {
      read: async () => checkpoint,
      create: async (value, _lease, events) => { checkpoint = structuredClone(value); outbox.push(...events) },
      commit: async change => { assert.equal(checkpoint?.version, change.expectedVersion); checkpoint = structuredClone(change.checkpoint); outbox.push(...change.events); committedToolResults.push(...change.checkpoint.toolResults) },
      pendingEvents: async () => outbox, acknowledgeEvents: async () => {},
    },
    leases: { acquire: async () => ({ token: 'synthetic-lease', fence: 1 }), assert: async () => {}, release: async () => {} },
    cancellation: { isRequested: async () => false, request: async () => {}, notify: async () => {}, subscribe: async () => () => {} },
    tools: registry.tools, interactions: { activate: async (_id, request) => request },
    sanitizeText: stripThinking, createStreamSanitizer: () => new ProviderStreamSanitizer(),
    presentError: () => ({ code: 'failed', text: '合成运行失败' }), presentToolResult: async value => value,
    publish: async () => {}, diagnose: () => {},
  }
  const wireResults = new Map<string, unknown>()
  let requests = 0
  const instance = createAgentRuntime({ context, runtime,
    executor: { authorize: async () => { throw new Error('只读工具不得授权执行器') }, executor: { execute: async () => { throw new Error('只读工具不得执行进程') } } },
    provider: { resolve: bound.resolve, transport: { request: async request => {
      requests++
      const body = request.body as Record<string, unknown>
      if (requests === 1) {
        const definitions = body.tools as Array<{ function: { name: string } }>
        assert.deepEqual(definitions.map(tool => tool.function.name).sort(), custom ? [...custom.names].sort() : ['get_current_time', 'list_clients', 'list_projects'])
        // 目录已发现后撤权，dispatch必须重新授权；模型参数不得覆盖可信时区。
        if (reject) allowed.delete('list_clients')
        const calls = custom ? custom.calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) : [
          { index: 0, id: 'clients', type: 'function', function: { name: 'list_clients', arguments: '{}' } },
          { index: 1, id: 'projects', type: 'function', function: { name: 'list_projects', arguments: JSON.stringify(reject ? { status: '非法状态' } : {}) } },
          { index: 2, id: 'time', type: 'function', function: { name: 'get_current_time', arguments: JSON.stringify({ timezone: 'America/New_York' }) } },
        ]
        return response({ tool_calls: calls }, 'tool_calls')
      }
      assert.equal(requests, 2)
      const messages = body.messages as Array<{ role: string; tool_call_id?: string; content?: unknown }>
      const actual = messages.filter(message => message.role === 'tool')
      assert.deepEqual(actual.map(message => message.tool_call_id), custom ? custom.calls.map(call => call.id) : ['clients', 'projects', 'time'])
      for (const message of actual) {
        // 真实Provider缓存投影可把JSON文本包为单个ephemeral text块；仍读取实际wire正文。
        let content = message.content
        if (typeof content !== 'string') {
          assert.ok(Array.isArray(content))
          assert.equal(content.length, 1)
          assert.deepEqual(Object.keys(content[0]).sort(), ['cache_control', 'text', 'type'])
          assert.equal(content[0].type, 'text')
          assert.deepEqual(content[0].cache_control, { type: 'ephemeral' })
          content = content[0].text
        }
        assert.equal(typeof content, 'string')
        wireResults.set(message.tool_call_id!, JSON.parse(content as string))
      }
      return response({ content: reject ? '部分查询未完成。' : '查询结果已读取。' }, 'stop')
    } } },
  })
  const events: RunEvent[] = []
  try {
    for await (const event of instance.harness.start(identity)) events.push(event)
    assert.equal(requests, 2)
    assert.equal(events.at(-1)?.payload.status, 'completed')
    assert.ok(committedToolResults.length >= (custom?.calls.length ?? 3))
    return { wireResults, events, identity }
  } finally { await instance.close(); bound.release() }
}
function response(delta: Record<string, unknown>, finish: string) {
  return { status: 200, headers: {}, body: (async function* () {
    yield new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)
  })(), cancel: async () => {} }
}

test('独立Host runtime→真实registry→隔离PG只读工具→Provider续轮，非生产Run总装验收', {
  skip: !databaseUrl && '需要显式隔离 PostgreSQL 测试连接', timeout: 30000,
}, async () => {
  const schema = `gugu_read_tools_runtime_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 2 })
  try {
    const definitions = tablesSql('postgres')
    await pool.query(definitions.projects); await pool.query(definitions.clients)
    const owner = randomUUID(), other = randomUUID()
    for (const [id, suffix] of [[owner, '甲'], [other, '乙']]) await core.transaction(dataContext(id!), async data => {
      await data.clients.create({ name: `合成联系人${suffix}`, notes: `备注${suffix}` })
      await data.projects.create({ name: `合成项目${suffix}` })
    })
    const before = { clients: (await pool.query('SELECT * FROM clients ORDER BY id')).rows, projects: (await pool.query('SELECT * FROM projects ORDER BY id')).rows }
    for (const [id, suffix, timezone, date, time] of [[owner, '甲', 'Asia/Shanghai', '2026-01-02', '04:00:00'], [other, '乙', 'UTC', '2026-01-01', '20:00:00']]) {
      const result = await runReadRound(core, id!, timezone!)
      assert.deepEqual((result.wireResults.get('clients') as Array<{ name: string }>).map(item => item.name), [`合成联系人${suffix}`])
      assert.deepEqual((result.wireResults.get('projects') as Array<{ name: string }>).map(item => item.name), [`合成项目${suffix}`])
      assert.deepEqual(result.wireResults.get('time'), { date, weekday: date === '2026-01-02' ? '星期五' : '星期四', time, datetime: `${date} ${time}`, timezone, ignored_fields:['timezone'], hint:'以下字段不在 get_current_time 的当前 schema 中，已被忽略：timezone。参数形状与预期不符时，先调用 get_tool_schema 确认最新参数再重试。' })
      assert.equal(result.events.filter(event => event.type === 'tool_done' && event.payload.status === 'success').length, 3)
    }
    const fixed = await runReadRound(core, owner, 'UTC-03:30')
    assert.deepEqual(fixed.wireResults.get('time'), { date: '2026-01-01', weekday: '星期四', time: '16:30:00', datetime: '2026-01-01 16:30:00', timezone: 'UTC-03:30', ignored_fields:['timezone'], hint:'以下字段不在 get_current_time 的当前 schema 中，已被忽略：timezone。参数形状与预期不符时，先调用 get_tool_schema 确认最新参数再重试。' })
    assert.deepEqual((fixed.wireResults.get('clients') as Array<{ name: string }>).map(item => item.name), ['合成联系人甲'])
    const denied = await runReadRound(core, owner, 'Asia/Shanghai', true)
    assert.ok((denied.wireResults.get('clients') as { error: unknown }).error)
    assert.ok((denied.wireResults.get('projects') as { error: unknown }).error)
    assert.equal(denied.events.filter(event => event.type === 'tool_done' && event.payload.status === 'error').length, 2)
    assert.deepEqual({ clients: (await pool.query('SELECT * FROM clients ORDER BY id')).rows, projects: (await pool.query('SELECT * FROM projects ORDER BY id')).rows }, before)
  } finally {
    await core.close(); await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})


test('七个工具经Host runtime、真实共享服务和隔离PG续轮，项目收据恢复不重做业务', { skip: !databaseUrl && '需要隔离PG', timeout: 30000 }, async () => {
  const schema = `gugu_tool_groups_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 }); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 3 })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema, maxConnections: 4 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-tool-group-files-'))
  const owner = randomUUID(), other = randomUUID(), names = ['list_events','list_workspaces','get_workspace','get_dashboard_stats','update_project','set_color','archive_project']
  let moves = 0, published = 0, allowed = true
  try {
    const ddl = tablesSql('postgres')
    for (const table of [ddl.projects,ddl.clients,ddl.calendarEvents,ddl.scheduledTasks,ddl.receipts,ddl.undo]) await pool.query(table)
    await pool.query(`CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,project_id integer,storage_key text,deleted_at timestamptz);
      CREATE VIEW project_file_counts AS SELECT project_id,count(*)::bigint AS file_count FROM files WHERE deleted_at IS NULL GROUP BY project_id;
      CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,name text);
      CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,name text);
      CREATE TABLE workspaces(id integer PRIMARY KEY,user_id uuid,name text,kind text,enabled boolean,is_default boolean,project_id integer,folder_id integer,directory_id integer,updated_at timestamptz);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,workspace_id integer)`)
    const projects = await core.transaction(dataContext(owner), async data => [await data.projects.create({name:'待改名😀',start_date:'2026-11-01'}),await data.projects.create({name:'待换色'}),await data.projects.create({name:'待归档'})])
    const foreign = await core.transaction(dataContext(other), data=>data.projects.create({name:'他人私有项目'}))
    const old = `${owner}/项目文件/2026/11/待改名😀 #${projects[0]!.id}`
    await mkdir(join(root,old),{recursive:true});await writeFile(join(root,old,'own.txt'),'合成内容')
    await pool.query('INSERT INTO files VALUES(1,$1,$2,$3,NULL),(2,$4,$5,$6,NULL)',[owner,projects[0]!.id,old+'/own.txt',other,foreign.id,'synthetic-other'])
    await pool.query(`INSERT INTO workspace_directories VALUES(7,$1,'自有顶层目录'),(8,$2,'他人顶层目录');`,[owner,other])
    await pool.query(`INSERT INTO workspaces VALUES(1,$1,'项目绑定','project',false,false,$3,NULL,NULL,'2026-11-01'),(2,$1,'目录绑定','directory',true,true,NULL,NULL,7,'2026-11-01'),(3,$2,'他人绑定','directory',true,true,NULL,NULL,8,'2026-11-01')`,[owner,other,projects[0]!.id])
    await pool.query('INSERT INTO conversation_sessions VALUES(1,$1,2),(2,$1,2),(3,$2,2)',[owner,other])
    await pool.query(`INSERT INTO calendar_events(id,user_id,title,date,time,type,version,created_at) VALUES(1,$1,'自有活动','2026-11-15','09:00','event',1,now()),(2,$2,'他人活动','2026-11-15','09:00','event',1,now())`,[owner,other])
    await pool.query(`INSERT INTO scheduled_tasks(id,user_id,event_id,name,payload,cron,schedule_kind,start_at,channels,enabled,delivery_targets,created_at,updated_at)
      VALUES(1,$1,1,'提醒','不应进入模型的正文','@once:synthetic','once','2026-11-15 00:59:29.999999+00','qq',false,'{"qq":{"chat_type":"group"}}',now(),now())`,[owner])
    const runtime = createPostgresProjectUpdateRuntime(pool,async(_owner,from,to,_before,onMoved)=>{
      await mkdir(dirname(join(root,to)),{recursive:true});await rename(join(root,from),join(root,to));moves++;onMoved?.()
    },async()=>{published++})
    const mutations = createDurableProjectMutationPort({core,runtime,metadata:()=>({undoContextId:'agent-session-1'})})
    const options = {core,authorize:async(identity: {ownerId:string},name:string)=>allowed && identity.ownerId===owner && names.includes(name),
      time:{now:()=>new Date('2026-11-15T00:00:00Z'),timezone:async()=> 'Asia/Shanghai'},
      calendar:createAgentCalendarReader(createKyselyCalendarAgentReadPort(core.db,'postgres')),
      workspaces:createAgentWorkspaceQueries(createKyselyAgentWorkspaceReader(core.db,'postgres')),
      dashboard:createKyselyDashboardCounter(core.db,'postgres'),projectMutations:mutations}
    const registry = createAgentToolRegistry(options)
    const reads = await runReadRound(core,owner,'Asia/Shanghai',false,{registry,names,calls:[
      {id:'events',name:'list_events',input:{from:'2026-11-15',to:'2026-11-15'}},
      {id:'workspaces',name:'list_workspaces',input:{}},{id:'workspace',name:'get_workspace',input:{workspace_id:2}},
      {id:'stats',name:'get_dashboard_stats',input:{owner_id:other}},
    ]})
    assert.deepEqual((reads.wireResults.get('events') as Array<{title:string;reminders:unknown[]}>).map(row=>row.title),['自有活动'])
    assert.deepEqual((reads.wireResults.get('events') as Array<{reminders:unknown[]}>)[0]!.reminders,[{lead_minutes:1,channels:['qq'],enabled:false,delivery_mode:'current_group'}])
    assert.deepEqual((reads.wireResults.get('workspaces') as Array<{workspace_id:number}>).map(row=>row.workspace_id),[2,1])
    assert.equal((reads.wireResults.get('workspace') as {bound_session_count:number}).bound_session_count,2)
    assert.deepEqual(reads.wireResults.get('stats'),{projects:{pending:3,active:0,done:0,total:3},upcoming_events:1,files:1,clients:0,
      ignored_fields:['owner_id'],hint:'以下字段不在 get_dashboard_stats 的当前 schema 中，已被忽略：owner_id。参数形状与预期不符时，先调用 get_tool_schema 确认最新参数再重试。'})
    assert.doesNotMatch(JSON.stringify([...reads.wireResults]),/他人|不应进入模型/)
    const calls = [{id:'update',name:'update_project',input:{project_id:projects[0]!.id,project_name:'已改名😀',status:'done'}},
      {id:'color',name:'set_color',input:{project_id:projects[1]!.id,color:'teal'}},
      {id:'archive',name:'archive_project',input:{project_id:projects[2]!.id}}]
    const changed = await runReadRound(core,owner,'Asia/Shanghai',false,{registry,names,calls})
    assert.equal((changed.wireResults.get('update') as {name:string}).name,'已改名😀')
    assert.equal((changed.wireResults.get('color') as {color:string}).color,'teal')
    assert.equal((changed.wireResults.get('archive') as {archived:boolean}).archived,true)
    assert.equal(moves,1);assert.equal(published,3)
    assert.equal(await readFile(join(root,`${owner}/项目文件/2026/11/已改名😀 #${projects[0]!.id}`,'own.txt'),'utf8'),'合成内容')
    assert.equal((await pool.query('SELECT count(*)::int n FROM core_operation_receipts')).rows[0].n,3)
    const rebuilt = createAgentToolRegistry({...options,projectMutations:createDurableProjectMutationPort({core,runtime})})
    for (const call of calls) {
      const restored = await rebuilt.tools.reconcile(call,{...changed.identity,roundId:`${changed.identity.runId}:1`})
      assert.equal(restored.kind,'completed');if(restored.kind==='completed'){assert.equal(restored.successful,true);assert.equal(restored.mutated,false)}
    }
    assert.equal(moves,1);assert.equal(published,3)
    const repeated={id:'concurrent',name:'set_color',input:{project_id:projects[1]!.id,color:'rose'}}
    const scope={identity:{ownerId:owner,sessionId:'1',runId:'concurrent'},roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
    const results=await Promise.all([registry.tools.dispatch(repeated,scope),rebuilt.tools.dispatch(repeated,scope)])
    assert.equal(results.filter(result=>result.kind==='completed'&&result.mutated).length,1)
    allowed=false
    assert.deepEqual(await registry.capabilities(scope.identity),[])
    assert.equal((await core.transaction(dataContext(other),data=>data.projects.get(foreign.id)))!.name,'他人私有项目')
  } finally {await core.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
})

test('新增八工具经Host runtime和隔离PG续轮：阶段顺序修改、笔记关系引用与Schema按权发现', {skip:!databaseUrl&&'需要隔离PG',timeout:30000},async()=>{
 const schema='gugu_stage_note_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query('CREATE SCHEMA "'+schema+'"')
 const pool=new Pool({connectionString:databaseUrl,options:'-c search_path='+schema,max:2})
 const core=await createPostgresRuntime({url:databaseUrl!,schema,maxConnections:3})
 const owner=randomUUID(),other=randomUUID(),names=['add_stage','rename_stage','update_stage','set_stages','remove_stage','note_search','note_get','get_tool_schema']
 let allowed=true,published=0
 try{
  const ddl=tablesSql('postgres')
  for(const table of [ddl.projects,ddl.clients,ddl.calendarEvents,ddl.receipts,ddl.undo,ddl.mindNodes,ddl.mindMaps,ddl.mindRelations])await pool.query(table)
  await pool.query('CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,project_id integer,display_name text,storage_key text,deleted_at timestamptz)')
  await pool.query('CREATE VIEW project_file_counts AS SELECT project_id,count(*)::bigint AS file_count FROM files WHERE deleted_at IS NULL GROUP BY project_id')
  const project=await core.transaction(dataContext(owner),data=>data.projects.create({name:'阶段测试',current_stage:'s0',stages:[
    {key:'s0',label:'计划',todos:[{id:'t0',text:'原待办',done:false}]},{key:'s1',label:'执行',todos:[]}]}))
  const foreign=await core.transaction(dataContext(other),data=>data.projects.create({name:'他人私有项目'}))
  const markdown='# 重构\n正文 [[project:'+project.id+'|旧项目名]] [[project:'+foreign.id+'|不可读]] [[file:1|旧文件名]]'
  await pool.query("INSERT INTO files VALUES(1,$1,$2,'当前文件名','synthetic',NULL)",[owner,project.id])
  await pool.query("INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES "+
    "(1,$1,'note','重构笔记',$3,'重构 条件甲','gugu',1,'2026-11-15 00:00:00.000001+00',now(),now()),"+
    "(2,$1,'canvas_note','相关便签','相关正文','条件乙','user',1,'2026-11-14+00',now(),now()),"+
    "(3,$2,'note','他人私有笔记','不应泄漏','重构','user',1,'2026-11-15+00',now(),now())",[owner,other,markdown])
  await pool.query("INSERT INTO mind_relations(user_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) "+
    "VALUES($1,1,2,'related','','user','confirmed',now(),now()),($1,1,3,'related','','user','confirmed',now(),now())",[owner])
  const runtime=createPostgresProjectUpdateRuntime(pool,async()=>{throw new Error('阶段工具不应移动物理目录')},async()=>{published++})
  const mutationOptions={core,runtime,metadata:()=>({undoContextId:'stage-session'})}
  const options={core,notes:createAgentMindReader(core.db,'postgres'),projectMutations:createDurableProjectMutationPort(mutationOptions),
    authorize:async(identity:{ownerId:string},name:string)=>allowed&&identity.ownerId===owner&&names.includes(name)}
  const registry=createAgentToolRegistry(options)
  const reads=await runReadRound(core,owner,'UTC',false,{registry,names,calls:[
    {id:'schema',name:'get_tool_schema',input:{tools:['note_*','add_stage','missing']}},
    {id:'search',name:'note_search',input:{query:'重构'}},{id:'note',name:'note_get',input:{node_id:1}},
  ]})
  assert.deepEqual(reads.wireResults.get('schema'),{tool_schemas:['note_search','note_get','add_stage'],rejected:['missing']})
  assert.deepEqual((reads.wireResults.get('search') as {matches:Array<{node_id:number;captured_at:string}>}).matches.map(row=>[row.node_id,row.captured_at]),[[1,'2026-11-15T00:00:00.000001+00:00']])
  const note=reads.wireResults.get('note') as {node:{numbered_content:string};related:Array<{node:{node_id:number}}>;references:unknown[]}
  assert.match(note.node.numbered_content,/1: # 重构\n2: 正文/)
  assert.deepEqual(note.related.map(row=>row.node.node_id),[2])
  assert.deepEqual(note.references,[{ref_type:'project',ref_id:project.id,label:'阶段测试'},{ref_type:'file',ref_id:1,label:'当前文件名'}])
  assert.doesNotMatch(JSON.stringify(reads.wireResults.get('search')),/他人私有|不应泄漏/)
  const calls=[
    {id:'add',name:'add_stage',input:{project_id:project.id,label:'验收'}},
    {id:'rename',name:'rename_stage',input:{project_id:project.id,stage:'s2',new_label:'交付'}},
    {id:'todos',name:'update_stage',input:{project_id:project.id,stage:'s0',add:['新增'],todos:[
      {text:'t0',new_text:'不得生效',done:true,to_stage:'missing'},{text:'t1',done:true,to_stage:'s2'}]}},
    {id:'set',name:'set_stages',input:{project_id:project.id,stages:[{key:'s2',label:'交付'},{key:'s0',label:'计划'}]}},
    {id:'remove',name:'remove_stage',input:{project_id:project.id,stage:'s0'}},
  ]
  const completed:Array<{call:typeof calls[number];identity:{ownerId:string;sessionId:string;runId:string}}>=[]
  // 分别发起真实Run表达顺序依赖；不假称同轮并发写入具备跨调用排序。
  for(const call of calls){
    const round=await runReadRound(core,owner,'UTC',false,{registry,names,calls:[call]})
    const value=round.wireResults.get(call.id) as {success:boolean;results?:Array<{error?:string}>}
    assert.equal(value.success,true)
    if(call.id==='todos')assert.equal(value.results![1]!.error,'目标阶段不存在: missing')
    completed.push({call,identity:round.identity})
  }
  const final=await core.transaction(dataContext(owner),data=>data.projects.get(project.id))
  assert.equal(final!.version,6);assert.equal(final!.current_stage,'s2')
  assert.deepEqual(JSON.parse(final!.stages_json),[{key:'s2',label:'交付',todos:[{id:'t1',text:'新增',done:true}]}])
  assert.equal((await pool.query('SELECT count(*)::int n FROM undo_operations')).rows[0].n,5)
  assert.equal((await pool.query('SELECT count(*)::int n FROM core_operation_receipts')).rows[0].n,5)
  assert.equal(published,5)
  const rebuilt=createAgentToolRegistry({...options,projectMutations:createDurableProjectMutationPort(mutationOptions)})
  for(const {call,identity} of completed){
    const result=await rebuilt.tools.reconcile(call,{...identity,roundId:identity.runId+':1'})
    assert.equal(result.kind,'completed');if(result.kind==='completed'){assert.equal(result.successful,true);assert.equal(result.mutated,false)}
  }
  assert.equal(published,5)
  assert.equal((await core.transaction(dataContext(other),data=>data.projects.get(foreign.id)))!.version,1)
  const concurrent={id:'stage-concurrent',name:'add_stage',input:{project_id:project.id,label:'并发新增'}}
  const parallelScope={identity:{ownerId:owner,sessionId:'1',runId:'concurrent-stage'},roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
  const parallel=await Promise.all([registry.tools.dispatch(concurrent,parallelScope),rebuilt.tools.dispatch(concurrent,parallelScope)])
  assert.equal(parallel.filter(row=>row.kind==='completed'&&row.mutated).length,1)
  const concurrentProject=await core.transaction(dataContext(owner),data=>data.projects.get(project.id))
  assert.equal(concurrentProject!.version,7)
  assert.deepEqual(JSON.parse(concurrentProject!.stages_json).map((stage:{key:string})=>stage.key),['s2','s3'])
  assert.equal(published,6)
  registry.configure({groups:{mind:false}})
  const request={id:'schema-now',name:'get_tool_schema',input:{tools:['note_*']}}
  const scope={identity:{ownerId:owner,sessionId:'1',runId:'schema-revoke'},roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
  const hidden=await registry.tools.dispatch(request,scope)
  assert.equal(hidden.kind,'completed');if(hidden.kind==='completed')assert.equal(hidden.successful,false)
  allowed=false;assert.deepEqual(await registry.capabilities(scope.identity),[])
 }finally{await core.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end()}
})

test('工作区更新和画布列表经真实Host续轮与隔离PG，目录显示名和收据原子提交', {skip:!databaseUrl&&'需要隔离PG',timeout:30000},async()=>{
 const schema='gugu_workspace_canvas_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query('CREATE SCHEMA "'+schema+'"')
 const pool=new Pool({connectionString:databaseUrl,options:'-c search_path='+schema,max:2})
 const core=await createPostgresRuntime({url:databaseUrl!,schema,maxConnections:3})
 const owner=randomUUID(),other=randomUUID(),names=['canvas_list','canvas_get','canvas_search','canvas_focus_node','update_workspace'];let allowed=true
 try{
  const ddl=tablesSql('postgres')
  for(const table of [ddl.projects,ddl.clients,ddl.receipts,ddl.mindNodes,ddl.mindMaps,ddl.mindItems,ddl.mindRelations])await pool.query(table)
  await pool.query('CREATE TABLE folders(id integer PRIMARY KEY,user_id uuid,name text,deleted_at timestamptz)')
  await pool.query('CREATE TABLE workspace_directories(id integer PRIMARY KEY,user_id uuid,name text,directory_name text,is_system boolean,is_default boolean,deleted_at timestamptz,created_at timestamptz,updated_at timestamptz)')
  await pool.query('CREATE TABLE workspaces(id integer PRIMARY KEY,user_id uuid,name text,kind text,folder_id integer,project_id integer,directory_id integer,enabled boolean,is_default boolean,created_at timestamptz,updated_at timestamptz)')
  await pool.query('CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid,workspace_id integer)')
  await pool.query("INSERT INTO workspace_directories VALUES(7,$1,'目录','frozen-segment',false,false,NULL,now(),now())",[owner])
  await pool.query("INSERT INTO workspaces VALUES(1,$1,'目录','directory',NULL,NULL,7,true,false,now(),now()),(2,$1,'同目录绑定','directory',NULL,NULL,7,true,false,now(),now()),(3,$2,'他人目录','directory',NULL,NULL,7,true,false,now(),now())",[owner,other])
  await pool.query('INSERT INTO conversation_sessions VALUES(1,$1,1),(2,$2,1)',[owner,other])
  await pool.query("INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at) VALUES(1,$1,'自有画布','{\"x\":false,\"viewport\":{\"width\":800}}',now(),'2026-11-15 00:00:00.000001+00'),(2,$2,'他人画布','{}',now(),now())",[owner,other])
  await pool.query("INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES(1,$1,'canvas_note','检索节点甲','正文甲','检索 甲','gugu',1,now(),now(),now()),(2,$1,'canvas_note','检索节点乙','正文乙','检索 乙','gugu',1,now(),now(),now())",[owner])
  await pool.query("INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at) VALUES(1,$1,1,1,0,0,1,false,'{}',now(),now()),(2,$1,1,2,600,0,2,false,'{}',now(),now())",[owner])
  await pool.query("INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) VALUES(1,$1,1,1,2,'related','','user','confirmed',now(),now())",[owner])
  const options={core,canvases:createSqlMindCanvasReader(core.db,'postgres'),workspaceMutations:createWorkspaceMutationPort(core),
   authorize:async(identity:{ownerId:string},name:string)=>allowed&&identity.ownerId===owner&&names.includes(name)}
  const registry=createAgentToolRegistry(options),update={id:'workspace',name:'update_workspace',input:{workspace_id:1,workspace_name:'新显示名',enabled:false}}
  const result=await runReadRound(core,owner,'UTC',false,{registry,names,calls:[update,{id:'canvases',name:'canvas_list',input:{limit:1}},
    {id:'snapshot',name:'canvas_get',input:{canvas_id:1,limit:1}},
    {id:'search-canvas',name:'canvas_search',input:{canvas_id:1,query:'检索',limit:1}},
    {id:'focus-canvas',name:'canvas_focus_node',input:{canvas_id:1,item_id:2}}]})
  assert.deepEqual(result.wireResults.get('workspace'),{success:true,workspace:{workspace_id:1,name:'新显示名',kind:'directory',enabled:false,is_default:false,bound_session_count:1,project_id:null,folder_id:null,directory_id:7,directory_name:'新显示名'}})
  const canvases=result.wireResults.get('canvases') as {total:number;canvases:Array<{canvas_id:number;updated_at:string;view:unknown}>}
  const snapshot=result.wireResults.get('snapshot') as {pagination:{total:number};relation_audit:Array<{status:string}>}
  assert.equal(snapshot.pagination.total,2);assert.equal(snapshot.relation_audit[0]!.status,'incomplete')
  const search=result.wireResults.get('search-canvas') as {count:number;truncated:boolean;matches:Array<{node_id:number}>}
  assert.equal(search.count,2);assert.equal(search.truncated,true);assert.equal(search.matches[0]!.node_id,2)
  assert.equal((result.wireResults.get('focus-canvas') as {focus_link:string}).focus_link,'gugu://focus-canvas/1/2')
  assert.equal(canvases.total,1);assert.equal(canvases.canvases[0]!.canvas_id,1)
  assert.equal(canvases.canvases[0]!.updated_at,'2026-11-15T00:00:00.000001+00:00')
  assert.deepEqual(canvases.canvases[0]!.view,{camera:{x:false},viewport:{width:800},last_viewed_at:null})
  assert.deepEqual((await pool.query('SELECT name FROM workspaces ORDER BY id')).rows.map(row=>row.name),['新显示名','新显示名','他人目录'])
  assert.equal((await pool.query('SELECT directory_name FROM workspace_directories')).rows[0].directory_name,'frozen-segment')
  const rebuilt=createAgentToolRegistry({...options,workspaceMutations:createWorkspaceMutationPort(core)})
  const recovered=await rebuilt.tools.reconcile(update,{...result.identity,roundId:result.identity.runId+':1'})
  assert.equal(recovered.kind,'completed');if(recovered.kind==='completed'){assert.equal(recovered.successful,true);assert.equal(recovered.mutated,false)}
  assert.equal((await pool.query('SELECT count(*)::int n FROM core_operation_receipts')).rows[0].n,1)
  registry.configure({groups:{canvas:false,workspaces:false}})
  assert.deepEqual(await registry.capabilities(result.identity),[])
  allowed=false;assert.deepEqual(await registry.capabilities(result.identity),[])
 }finally{await core.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end()}
})


test('画布候选/创建和技能目录经真实Host工具续轮及PG共享服务', {skip:!databaseUrl&&'需要隔离PG',timeout:30000},async()=>{
 const schema='gugu_canvas_skills_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query('CREATE SCHEMA "'+schema+'"')
 const pool=new Pool({connectionString:databaseUrl,options:'-c search_path='+schema,max:2})
 const core=await createPostgresRuntime({url:databaseUrl!,schema,maxConnections:3})
 const owner=randomUUID(),other=randomUUID(),names=['canvas_create','canvas_search_placeable','list_skills'];let allowed=true,publications=0
 try{
  const ddl=tablesSql('postgres')
  for(const table of [ddl.projects,ddl.receipts,ddl.undo,ddl.mindNodes,ddl.mindMaps,ddl.mindItems])await pool.query(table)
  await pool.query('CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,stage_name text,updated_at timestamptz,deleted_at timestamptz)')
  await pool.query('CREATE TABLE calendar_events(id integer PRIMARY KEY,user_id uuid,title text,description text,contact_name text,created_at timestamptz,deleted_at timestamptz)')
  await pool.query('CREATE TABLE user_skills(owner_id uuid,skill_id text,name text,description_short text,category text,related_tools json,managed_by text,enabled boolean,source text)')
  await pool.query("INSERT INTO files VALUES(1,$1,'发布资料','md','准备',now(),NULL),(2,$2,'发布隐私','md','准备',now(),NULL)",[owner,other])
  await pool.query("INSERT INTO calendar_events VALUES(1,$1,'发布活动','发布说明','小北',now(),NULL)",[owner])
  await pool.query("INSERT INTO user_skills VALUES($1,'U1','停用简报','摘要','personal','[]',NULL,false,'user'),($2,'U2','他人技能','隐私','personal','[]','user',true,'user')",[owner,other])
  const defs=await createBuiltinSkillDefinitions([{name:'synthetic.md',read:async()=> '---\nid: S1\nname: 内置简报\ndescription_short: 摘要\nrelated_tools: canvas_create\n---\n不应返回正文'}],new AbortController().signal)
  const options={core,canvasCreation:createCanvasCreationPort(core,async()=>{publications++}),canvasPlaceableSearch:createAgentPlaceableSearch(core.db,'postgres'),skillMetadata:createSkillMetadataReader(core.db,'postgres',defs),
    authorize:async(identity:{ownerId:string},name:string)=>allowed&&identity.ownerId===owner&&names.includes(name)}
  const registry=createAgentToolRegistry(options)
  const calls=[{id:'new',name:'canvas_create',input:{title:'发布画布'}},{id:'placeable',name:'canvas_search_placeable',input:{query:'发布',limit:1}},{id:'skills',name:'list_skills',input:{}}]
  const result=await runReadRound(core,owner,'UTC',false,{registry,names,calls})
  assert.deepEqual(result.wireResults.get('new'),{canvas:{canvas_id:1,title:'发布画布',project_id:null}})
  const candidates=result.wireResults.get('placeable') as {count:number;truncated:boolean;matches:Array<{ref_type:string;ref_id:number}>}
  assert.equal(candidates.count,2);assert.equal(candidates.truncated,true);assert.equal(candidates.matches[0]!.ref_type,'file');assert.equal(candidates.matches[0]!.ref_id,1)
  const skills=result.wireResults.get('skills') as {count:number;skills:Array<{id:string;enabled:boolean}>}
  assert.equal(skills.count,2);assert.equal(skills.skills.find(row=>row.id==='U1')!.enabled,false)
  assert.equal(JSON.stringify(skills).includes('不应返回正文'),false)
  assert.equal(publications,1)
  const rebuilt=createAgentToolRegistry(options)
  const recovered=await rebuilt.tools.reconcile(calls[0]!,{...result.identity,roundId:result.identity.runId+':1'})
  assert.equal(recovered.kind,'completed');if(recovered.kind==='completed')assert.equal(recovered.mutated,false)
  assert.equal((await pool.query('SELECT count(*)::int n FROM mind_maps')).rows[0].n,1)
  assert.equal((await pool.query('SELECT count(*)::int n FROM undo_operations')).rows[0].n,1)
  assert.equal((await pool.query('SELECT count(*)::int n FROM mind_nodes')).rows[0].n,0)
  registry.configure({groups:{canvas:false,skill_management:false}});assert.deepEqual(await registry.capabilities(result.identity),[])
  allowed=false;assert.deepEqual(await rebuilt.capabilities(result.identity),[])
  const absent=createAgentToolRegistry({core,authorize:async()=>true})
  assert.equal((await absent.capabilities(result.identity)).some(row=>names.includes(row.name)),false)
 }finally{await core.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end()}
})

test('画布三种编辑经真实Host续轮与PG：布局、正文和移除视图分离并可恢复收据', {skip:!databaseUrl&&'需要隔离PG',timeout:30000},async()=>{
 const schema='gugu_canvas_edits_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query('CREATE SCHEMA "'+schema+'"')
 const pool=new Pool({connectionString:databaseUrl,options:'-c search_path='+schema,max:2})
 const core=await createPostgresRuntime({url:databaseUrl!,schema,maxConnections:3})
 const owner=randomUUID(),other=randomUUID(),names=['canvas_update_node','canvas_remove_node','canvas_update_note'];let allowed=true,events=0
 try{
  const ddl=tablesSql('postgres')
  for(const table of [ddl.projects,ddl.receipts,ddl.undo,ddl.mindNodes,ddl.mindMaps,ddl.mindItems,ddl.mindRelations])await pool.query(table)
  await pool.query("INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at) VALUES(1,$1,'画布','{}',now(),now()),(2,$2,'他人画布','{}',now(),now())",[owner,other])
  await pool.query("INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES(1,$1,'canvas_note','原题','# 原文','原文','user',1,now(),now(),now()),(2,$1,'canvas_note','第二项','','','user',1,now(),now(),now()),(3,$2,'canvas_note','他人项','','','user',1,now(),now(),now())",[owner,other])
  await pool.query("INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at) VALUES(1,$1,1,1,0,0,0,false,'{}',now(),now()),(2,$1,1,2,500,0,1,false,'{}',now(),now())",[owner])
  await pool.query("INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) VALUES(1,$1,1,1,2,'related','','user','confirmed',now(),now())",[owner])
  const options={core,canvasEdits:createCanvasEditPort(core,async()=>{events++}),authorize:async(identity:{ownerId:string},name:string)=>allowed&&identity.ownerId===owner&&names.includes(name)}
  const registry=createAgentToolRegistry(options)
  const calls=[{id:'layout',name:'canvas_update_node',input:{canvas_id:1,item_id:1,x:88,width:300}},{id:'body',name:'canvas_update_note',input:{node_id:1,content:'# 更新正文',color:'teal'}},{id:'remove',name:'canvas_remove_node',input:{canvas_id:1,item_id:2}}]
  const result=await runReadRound(core,owner,'UTC',false,{registry,names,calls})
  assert.equal((result.wireResults.get('layout') as {node:{position:{x:number};size:{w:number}}}).node.position.x,88)
  assert.equal((result.wireResults.get('layout') as {node:{size:{w:number}}}).node.size.w,300)
  assert.equal((result.wireResults.get('body') as {node:{preview:string}}).node.preview,'更新正文')
  assert.deepEqual(result.wireResults.get('remove'),{canvas_id:1,removed_item_id:2,node_id:2,node_preserved:true})
  const node=(await pool.query('SELECT content_md,content_plain,version,color FROM mind_nodes WHERE id=1')).rows[0]
  assert.deepEqual(node,{content_md:'# 更新正文',content_plain:'更新正文',version:2,color:'teal'})
  assert.equal((await pool.query('SELECT deleted_at FROM mind_nodes WHERE id=2')).rows[0].deleted_at,null)
  assert.ok((await pool.query('SELECT deleted_at FROM mind_canvas_items WHERE id=2')).rows[0].deleted_at)
  assert.deepEqual(JSON.parse((await pool.query('SELECT data_json FROM mind_maps WHERE id=1')).rows[0].data_json),{detachedRelationIds:[1]})
  assert.equal(events,3)
  const rebuilt=createAgentToolRegistry(options)
  for(const call of calls){const recovered=await rebuilt.tools.reconcile(call,{...result.identity,roundId:result.identity.runId+':1'});assert.equal(recovered.kind,'completed');if(recovered.kind==='completed')assert.equal(recovered.mutated,false)}
  assert.equal((await pool.query('SELECT count(*)::int n FROM core_operation_receipts')).rows[0].n,3)
  const scope={identity:result.identity,roundId:'bad',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
  const rejected=await registry.tools.dispatch({id:'bad',name:'canvas_update_node',input:{canvas_id:1,updates:[{item_id:1,x:999},{item_id:999,x:1}]}},scope)
  assert.equal(rejected.kind,'completed');if(rejected.kind==='completed')assert.equal(rejected.successful,false)
  assert.equal((await pool.query('SELECT x FROM mind_canvas_items WHERE id=1')).rows[0].x,88)
  const foreign=await registry.tools.dispatch({id:'foreign',name:'canvas_update_note',input:{node_id:3,title:'不能改'}},scope)
  assert.equal(foreign.kind,'completed');if(foreign.kind==='completed')assert.equal(foreign.successful,false)
  allowed=false;assert.deepEqual(await registry.capabilities(result.identity),[])
  allowed=true;registry.configure({groups:{canvas:false}});assert.deepEqual(await registry.capabilities(result.identity),[])
  const absent=createAgentToolRegistry({core,authorize:async()=>true});assert.equal((await absent.capabilities(result.identity)).some(item=>names.includes(item.name)),false)
 }finally{await core.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end()}
})

test('画布创建便签/放置引用/端点更新经真实Host与PG续轮，不覆盖视图和关系', {skip:!databaseUrl&&'需要隔离PG',timeout:30000},async()=>{
 const schema='gugu_canvas_placement_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query('CREATE SCHEMA "'+schema+'"')
 const pool=new Pool({connectionString:databaseUrl,options:'-c search_path='+schema,max:2})
 const core=await createPostgresRuntime({url:databaseUrl!,schema,maxConnections:3})
 const owner=randomUUID(),other=randomUUID(),names=['canvas_create_note','canvas_add_node','canvas_update_anchor','canvas_connect'];let allowed=true,events=0
 try{
  const ddl=tablesSql('postgres')
  for(const table of [ddl.projects,ddl.receipts,ddl.undo,ddl.mindNodes,ddl.mindMaps,ddl.mindItems,ddl.mindRelations,ddl.calendarEvents])await pool.query(table)
  await pool.query('CREATE TABLE files(id integer PRIMARY KEY,user_id uuid,display_name text,ext text,deleted_at timestamptz)')
  await pool.query("INSERT INTO files VALUES(1,$1,'资料','md',NULL),(2,$2,'隐私','md',NULL)",[owner,other])
  await pool.query("INSERT INTO mind_maps(id,user_id,title,data_json,created_at,updated_at) VALUES(1,$1,'画布','{\"x\":100,\"y\":50,\"scale\":2,\"viewport\":{\"width\":1000,\"height\":800},\"preserve\":\"保留\"}',now(),now())",[owner])
  await pool.query("INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES(1,$1,'canvas_note','起点','','','user',1,now(),now(),now()),(2,$1,'canvas_note','终点','','','user',1,now(),now(),now())",[owner])
  await pool.query("INSERT INTO mind_canvas_items(id,user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at) VALUES(1,$1,1,1,0,0,0,false,'{}',now(),now()),(2,$1,1,2,500,0,1,false,'{}',now(),now())",[owner])
  await pool.query("SELECT setval(pg_get_serial_sequence('mind_nodes','id'),2,true),setval(pg_get_serial_sequence('mind_canvas_items','id'),2,true)")
  await pool.query("INSERT INTO mind_relations(id,user_id,canvas_id,src_node_id,dst_node_id,rel_type,edge_key,origin,status,created_at,updated_at) VALUES(1,$1,1,1,2,'related','','user','confirmed',now(),now())",[owner])
  const port=createCanvasEditPort(core,async()=>{events++})
  const options={core,canvasPlacements:port,canvasRelations:port,authorize:async(identity:{ownerId:string},name:string)=>allowed&&identity.ownerId===owner&&names.includes(name)}
  const registry=createAgentToolRegistry(options)
  const calls=[{id:'note',name:'canvas_create_note',input:{canvas_id:1,title:'便签',content:'# 新正文',width:300,position:{anchor:'viewport_center'}}},{id:'ref',name:'canvas_add_node',input:{canvas_id:1,ref_type:'file',ref_id:1,position:{x:-1,y:5}}},{id:'anchor',name:'canvas_update_anchor',input:{canvas_id:1,relation_id:1,source_side:'right',target_side:'left'}},{id:'connect',name:'canvas_connect',input:{canvas_id:1,source_node_id:2,target_node_id:1}}]
  const result=await runReadRound(core,owner,'UTC',false,{registry,names,calls})
  const note=result.wireResults.get('note') as {node:{node_id:number;position:{x:number;y:number};size:{w:number};preview:string};created:boolean}
  assert.equal(note.created,true);assert.deepEqual(note.node.position,{x:90,y:115});assert.equal(note.node.size.w,300);assert.equal(note.node.preview,'新正文')
  const ref=result.wireResults.get('ref') as {created:boolean;node:{ref_type:string;ref_id:number;position:{x:number;y:number}}}
  assert.equal(ref.created,true);assert.equal(ref.node.ref_type,'file');assert.equal(ref.node.ref_id,1);assert.deepEqual(ref.node.position,{x:-1,y:5})
  assert.deepEqual(result.wireResults.get('anchor'),{relation_id:1,source_node_id:1,target_node_id:2,source_side:'right',target_side:'left',updated:true})
  const connected=result.wireResults.get('connect') as {relation_id:number;changed:boolean;verification:{geometry_recommendation:unknown}}
  assert.equal(connected.relation_id,1);assert.equal(connected.changed,false);assert.deepEqual(connected.verification.geometry_recommendation,{source_side:'left',target_side:'right'})
  assert.equal((await pool.query('SELECT count(*)::int n FROM mind_relations')).rows[0].n,1)
  const data=JSON.parse((await pool.query('SELECT data_json FROM mind_maps WHERE id=1')).rows[0].data_json)
  assert.equal(data.preserve,'保留');assert.equal(data.scale,2);assert.deepEqual(data.viewport,{width:1000,height:800});assert.deepEqual(data.relationAnchors,{'1':{srcSide:'right',dstSide:'left'}})
  assert.equal((await pool.query('SELECT count(*)::int n FROM mind_nodes')).rows[0].n,4)
  assert.equal((await pool.query('SELECT count(*)::int n FROM core_operation_receipts')).rows[0].n,4);assert.equal(events,6)
  const rebuilt=createAgentToolRegistry(options)
  for(const call of calls){const recovered=await rebuilt.tools.reconcile(call,{...result.identity,roundId:result.identity.runId+':1'});assert.equal(recovered.kind,'completed');if(recovered.kind==='completed')assert.equal(recovered.mutated,false)}
  const scope={identity:result.identity,roundId:'bad',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
  const rejected=await registry.tools.dispatch({id:'bad',name:'canvas_add_node',input:{canvas_id:1,nodes:[{ref_type:'file',ref_id:2}]}},scope)
  assert.equal(rejected.kind,'completed');if(rejected.kind==='completed')assert.equal(rejected.successful,false)
  assert.equal((await pool.query('SELECT count(*)::int n FROM mind_nodes')).rows[0].n,4)
  allowed=false;assert.deepEqual(await registry.capabilities(result.identity),[])
  allowed=true;registry.configure({groups:{canvas:false}});assert.deepEqual(await registry.capabilities(result.identity),[])
  const absent=createAgentToolRegistry({core,authorize:async()=>true});assert.equal((await absent.capabilities(result.identity)).some(item=>names.includes(item.name)),false)
 }finally{await core.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end()}
})

test('笔记删除/恢复/撤销经真实Host与PG续轮，owner/类型边界及收据恢复不重选目标', {skip:!databaseUrl&&'需要隔离PG',timeout:30000},async()=>{
 const schema='gugu_note_lifecycle_'+randomUUID().replaceAll('-','')
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query('CREATE SCHEMA "'+schema+'"')
 const pool=new Pool({connectionString:databaseUrl,options:'-c search_path='+schema,max:2})
 const core=await createPostgresRuntime({url:databaseUrl!,schema,maxConnections:3})
 const owner=randomUUID(),other=randomUUID(),names=['note_delete','note_restore','note_undo'];let allowed=true,events=0
 try{
  const ddl=tablesSql('postgres');for(const table of [ddl.receipts,ddl.undo,ddl.mindNodes])await pool.query(table)
  const stamp='2026-11-15 00:00:00.123456+00'
  for(const [id,user,kind,origin,created] of [[1,owner,'note','user','2026-11-15 20:00:00+00'],[2,owner,'note','gugu','2026-11-15 01:00:00+00'],[3,owner,'note','gugu','2026-11-15 02:00:00+00'],[4,other,'note','gugu','2026-11-15 21:00:00+00'],[5,owner,'canvas_note','gugu','2026-11-15 22:00:00+00']] as const)
   await pool.query("INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES($1,$2,$3,'标题','# 正文','正文',$4,3,$5,$6,$5)",[id,user,kind,origin,stamp,created])
  const options={core,noteLifecycle:createNoteLifecyclePort(core,async()=>{events++}),authorize:async(identity:{ownerId:string},name:string)=>allowed&&identity.ownerId===owner&&names.includes(name)}
  const registry=createAgentToolRegistry(options)
  const calls=[{id:'delete-note',name:'note_delete',input:{node_id:1}},{id:'restore-note',name:'note_restore',input:{node_id:1}},{id:'undo-note',name:'note_undo',input:{}}]
  // 同轮工具按既有计划并发；删除→恢复存在依赖，应由独立用户Run依次完成。
  const rounds=[]
  for(const call of calls)rounds.push(await runReadRound(core,owner,'UTC',false,{registry,names,calls:[call]}))
  const result={identity:rounds[2]!.identity,wireResults:new Map(rounds.flatMap(round=>[...round.wireResults]))}
  assert.deepEqual(result.wireResults.get('delete-note'),{deleted_node_id:1,can_restore:true})
  assert.deepEqual(result.wireResults.get('undo-note'),{deleted_node_id:3,can_restore:true})
  const restored=result.wireResults.get('restore-note') as {note:{node_id:number;content_md:string;captured_at:string;origin:string}}
  assert.ok(restored.note,JSON.stringify(restored))
  assert.equal(restored.note.node_id,1);assert.equal(restored.note.content_md,'# 正文');assert.equal(restored.note.origin,'user');assert.equal(restored.note.captured_at,'2026-11-15T00:00:00.123456+00:00')
  const nodes=(await pool.query('SELECT id,version,deleted_at,content_md FROM mind_nodes ORDER BY id')).rows
  assert.equal(nodes[0].version,5);assert.equal(nodes[0].deleted_at,null);assert.equal(nodes[2].version,4);assert.ok(nodes[2].deleted_at)
  for(const index of [1,3,4]){assert.equal(nodes[index].version,3);assert.equal(nodes[index].deleted_at,null)}
  assert.equal(nodes.every(row=>row.content_md==='# 正文'),true);assert.equal(events,3)
  const rebuilt=createAgentToolRegistry(options)
  for(const [index,call] of calls.entries()){const identity=rounds[index]!.identity;const recovered=await rebuilt.tools.reconcile(call,{...identity,roundId:identity.runId+':1'});assert.equal(recovered.kind,'completed');if(recovered.kind==='completed')assert.equal(recovered.mutated,false)}
  assert.equal((await pool.query('SELECT count(*)::int n FROM core_operation_receipts')).rows[0].n,3)
  assert.equal((await pool.query('SELECT count(*)::int n FROM undo_operations')).rows[0].n,3)
  const scope={identity:result.identity,roundId:'bad',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行进程')}}
  for(const node_id of [4,5]){const rejected=await registry.tools.dispatch({id:'bad-'+node_id,name:'note_delete',input:{node_id}},scope);assert.equal(rejected.kind,'completed');if(rejected.kind==='completed')assert.equal(rejected.successful,false)}
  assert.equal((await pool.query('SELECT deleted_at FROM mind_nodes WHERE id=2')).rows[0].deleted_at,null)
  allowed=false;assert.deepEqual(await registry.capabilities(result.identity),[])
  allowed=true;registry.configure({groups:{mind:false}});assert.deepEqual(await registry.capabilities(result.identity),[])
  const absent=createAgentToolRegistry({core,authorize:async()=>true});assert.equal((await absent.capabilities(result.identity)).some(item=>names.includes(item.name)),false)
 }finally{await core.close();await pool.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end()}
})
