import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SqlDataRuntime } from '@gugu/core/data'
import type { AgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import { createGlobalSearchOperations, type GlobalSearchOperations } from '@gugu/core'
import type { ProjectCreateRuntime } from '@gugu/core/project-create'
import { createBuiltinSkillDefinitions, createSkillRegistry } from '@gugu/core/skills'
import type { ClientDeleteConfirmationPort, ClientDeletePort, CalendarDeleteConfirmationPort, CalendarDeletePort, CalendarEventCreateToolPort, CalendarEventUpdateToolPort, CanvasBatchConfirmationPort, CanvasBatchPort, CanvasDeleteNotePort, CanvasDisconnectPort, CanvasDeletePort, KnowledgeWritePort, ScheduledTaskListPort, UseSkillPorts } from '@gugu/core/tools'
import { createScheduledSendFileTool, createWebLinkButtonDeliveryPort, createUndoLastActionTool } from '@gugu/core/tools'
import { createAgentToolRegistry, filterConfiguredWebAgentTools, type AgentToolRegistryOptions } from '../../../src/modules/agent/tools/registry.js'
import { createWebAgentShell } from '../../../src/modules/agent/tools/shell/sandbox.js'

const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' }
function fixture(includeTime = false, includeOverview = false, includeProjects = true, skills?: UseSkillPorts, scheduledTasks?: ScheduledTaskListPort, search?: GlobalSearchOperations, extra: Pick<AgentToolRegistryOptions, 'events' | 'calendarCreate' | 'calendarUpdate' | 'calendarDelete' | 'diskTrashTools' | 'httpGet'> = {}) {
  const records: Array<{ id: number; userId: string; name: string; contact: null; email: null; phone: null; notes: string }> = []
  let enabled = new Set(['list_contacts', 'create_contact', 'create_project'])
  let failed = false, readFailed = false
  const core = { async transaction(ctx: { ownerId: string }, work: (data: unknown) => Promise<unknown>) {
    return work({ clients: { async list() { if (readFailed) throw new Error('合成私有异常'); return records.filter(row => row.userId === ctx.ownerId) },
      async create(value: { name: string; notes: string }) {
        if (failed) throw new Error('合成私有异常')
        const row = { id: records.length + 1, userId: ctx.ownerId, name: value.name, contact: null, email: null, phone: null, notes: value.notes }
        records.push(row); return row
      } } })
  } } as unknown as SqlDataRuntime
  const projects = { async transaction(work: (tx: unknown) => Promise<unknown>) {
    return work({ findIdempotent: async () => null, listActiveColors: async () => [], insertProject: async (owner: string, fields: Record<string, unknown>) => ({
      id: 10, user_id: owner, name: fields.name, stages_json: fields.stages_json, current_stage: fields.current_stage,
    }) })
  } } as unknown as ProjectCreateRuntime
  if (includeTime) enabled.add('get_current_time')
  if (includeOverview) enabled.add('get_project')
  const registry = createAgentToolRegistry({ ...extra, core, ...(includeProjects ? { projects } : {}), ...(skills ? { skills } : {}), ...(scheduledTasks ? { scheduledTasks } : {}), ...(search ? { search } : {}), authorize: async (_identity, name) => enabled.has(name),
    ...(includeTime ? { time: { now: () => new Date('2026-01-01T00:00:00Z'), timezone: async () => 'Asia/Shanghai' } } : {}),
    ...(includeOverview ? { fileOverview: async () => ({ total_file_count: 0, root_file_count: 0, total_folder_count: 0 }) } : {}) })
  return { ...registry, records, grant: (name: string) => { enabled.add(name) }, revoke: (name: string) => { enabled.delete(name) }, fail: () => { failed = true }, failRead: () => { readFailed = true } }
}

test('Main 工具白名单保留已接入的业务工具组名称，并过滤未知工具', () => {
  const configured = [
    'create_contact', 'update_contact', 'delete_contact', 'create_project', 'update_project', 'set_color', 'archive_project', 'add_stage',
    'remove_stage', 'rename_stage', 'set_stages', 'update_stage', 'create_workspace', 'update_workspace', 'set_project_workspace', 'undo_last_action', 'delete_folder', 'delete_file', 'compress_files', 'extract_files', 'global_search',
    'canvas_list', 'canvas_focus_node', 'canvas_search_placeable', 'canvas_create_note', 'canvas_delete', 'note_undo', 'call_tool', 'create_skill', 'update_skill', 'delete_skill',
    'note_create', 'note_update', 'delete_scheduled_task', 'web_search', 'similar_image_search', 'deep_research',
    'grep', 'read_file', 'save_uploaded_file', 'save_im_attachment', 'view_image', 'delete_folder', 'save_attachment', 'mcp_demo_lookup', 'unlink_workspace', 'delete_workspace_directory', 'untrusted_tool', 'mcp_demo_../lookup',
  ]
  const retired = new Set(['unlink_workspace', 'delete_workspace_directory', 'delete_folder', 'compress_files', 'extract_files', 'grep', 'read_file', 'save_uploaded_file', 'save_im_attachment'])
  assert.deepEqual(filterConfiguredWebAgentTools(configured), [...new Set(configured.slice(0, -2).filter(name => !retired.has(name)))])
})

test('Agent Shell 按风险和自动模式判定操作确认', async () => {
  let requested = 0, mountAttempts = 0
  let automaticModeEnabled = false, adminDangerousEnabled = true, systemEnabled = true
  let stopBeforeExecution = false, reads = 0
  const confirmation = {
    gate: {
      async prepare() {
        requested++
        return { ok: false }
      },
    },
  } as unknown as Parameters<typeof createWebAgentShell>[0]['confirmation']
  const shell = createWebAgentShell({
    rootfs: '/synthetic-rootfs', confirmation,
    async claim() { assert.fail('缺少确认时不能消费授权') },
    async mounts(_owner, _workspace, fullWrite) {
      assert.equal(fullWrite, false)
      mountAttempts++
      throw new Error('结束合成挂载')
    },
    async read() {
      reads++
      if (stopBeforeExecution && reads === 2) return null
      return { workspaceId: 1, workspaceTarget: '/workspace/current', systemEnabled, automaticModeEnabled, facts: {
        adminEnabled: true, sandboxEnabled: true, sandboxReady: true,
        sessionOwned: true, workspaceValid: true, filesystemAuthorizationAvailable: true,
        userEnabled: true, fullUserSandboxWrite: false, adminDangerousEnabled, userDangerousEnabled: true,
      } }
    },
  })
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, shell, authorize: async (_identity, name) => name === 'shell' })
  assert.equal((await registry.capabilities(identity)).some(tool => tool.name === 'shell'), true)
  await registry.tools.dispatch({ id: 'write', name: 'shell', input: { command: 'touch example' } }, scope())
  assert.equal(requested, 1)
  await registry.tools.dispatch({ id: 'untrusted', name: 'shell', input: { command: 'touch example', confirm: true } }, scope())
  assert.equal(requested, 1)

  automaticModeEnabled = true
  await registry.tools.dispatch({ id: 'auto', name: 'shell', input: { command: 'rm example' } }, scope())
  assert.equal(requested, 1)
  assert.equal(mountAttempts, 1)
  async function system(command: string) {
    reads = 0
    return registry.tools.dispatch({ id: 'system', name: 'shell', input: { command, scope: 'system' } }, scope())
  }
  stopBeforeExecution = true
  automaticModeEnabled = false
  await system('pwd')
  assert.equal(requested, 2)
  assert.equal(reads, 1)
  await system('rm example')
  assert.equal(requested, 3)
  assert.equal(reads, 1)
  automaticModeEnabled = true
  await system('rm example')
  assert.equal(requested, 3)
  assert.equal(reads, 2)
  adminDangerousEnabled = false
  await system('rm example')
  assert.equal(reads, 1)
  systemEnabled = false
  await system('pwd')
  assert.equal(reads, 1)
  assert.equal(requested, 3)
  assert.equal(mountAttempts, 1)
})

test('undo_last_action 仅在 Node Undo 端口已装配且当前授权有效时注册', async () => {
  let applies = 0
  const options = { core: {} as SqlDataRuntime, authorize: async (_current: typeof identity, name: string) => name === 'undo_last_action' }
  const absent = createAgentToolRegistry(options)
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'undo_last_action'), false)
  const ready = createAgentToolRegistry({ ...options, undoLastAction: createUndoLastActionTool({
    async apply() { applies++; return { kind: 'completed', successful: true, mutated: true, value: { operation_id: 'selected' } } },
    async reconcile() { return { kind: 'unknown' } },
  }) })
  assert.equal((await ready.capabilities(identity)).some(item => item.name === 'undo_last_action'), true)
  const result = await ready.tools.dispatch({ id: 'undo-call', name: 'undo_last_action', input: {} }, scope())
  assert.deepEqual(result, { kind: 'completed', successful: true, mutated: true, value: { operation_id: 'selected' } })
  assert.equal(applies, 1)
})

test('缺少项目创建后端时不开放写工具，已授权只读工具仍可用', async () => {
  const f = fixture(true, false, false)
  const names = (await f.capabilities(identity)).map(item => item.name)
  assert.ok(names.includes('list_contacts'))
  assert.ok(names.includes('get_current_time'))
  assert.equal(names.includes('create_project'), false)
  const denied = await f.tools.dispatch({ id: 'create', name: 'create_project', input: { project_name: '不可创建', start_date: '2026-01-01', deadline: '2026-02-01' } }, scope())
  assert.equal(denied.kind, 'completed')
  if (denied.kind === 'completed') { assert.equal(denied.successful, false); assert.equal(denied.executed, false) }
  const listed = await f.tools.dispatch({ id: 'list', name: 'list_contacts', input: {} }, scope())
  assert.equal(listed.kind, 'completed')
  if (listed.kind === 'completed') { assert.equal(listed.successful, true); assert.deepEqual(listed.value, []) }
})

test('delete_contact 只有可信确认及一次性事务 claim 端口存在时才进入工具 schema', async () => {
  const options = { core: {} as SqlDataRuntime, authorize: async (_identity: typeof identity, name: string) => name === 'delete_contact' }
  const absent = createAgentToolRegistry(options)
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'delete_contact'), false)
  const clientDelete: ClientDeletePort = {
    confirmation: { gate: {} as ClientDeleteConfirmationPort['gate'], async claim() { return false } },
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const ready = createAgentToolRegistry({ ...options, clientDelete })
  assert.equal((await ready.capabilities(identity)).some(item => item.name === 'delete_contact'), true)
})

test('知识写工具由 Host 注册器显式启用并继续使用可信 owner 身份', async () => {
  let authorized = true
  const entries: AgentKnowledgeEntry[] = []
  const observedOwners: string[] = []
  const knowledgeWrites: KnowledgeWritePort = {
    async list(current) { observedOwners.push(current.ownerId); return structuredClone(entries) },
    async commit(current, entry) {
      observedOwners.push(current.ownerId)
      entries.push(structuredClone(entry))
    },
  }
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, knowledgeWrites,
    authorize: async (_current, name) => authorized && ['save_knowledge', 'update_knowledge'].includes(name) })
  const names = (await registry.capabilities(identity)).map(item => item.name)
  assert.ok(names.includes('save_knowledge'))
  assert.ok(names.includes('update_knowledge'))
  const saved = await registry.tools.dispatch({ id: 'save-knowledge', name: 'save_knowledge', input: {
    title: '可信 owner', content: 'owner 只能来自 Run identity。', owner_id: '00000000-0000-4000-8000-000000000002', path: '/outside',
  } }, scope())
  assert.equal(saved.kind === 'completed' && saved.successful, true)
  assert.deepEqual(observedOwners, [identity.ownerId, identity.ownerId])
  assert.equal(entries[0]?.scope.owner_user_id, identity.ownerId)
  authorized = false
  const denied = await registry.tools.dispatch({ id: 'denied', name: 'save_knowledge', input: { title: '拒绝', content: '不写入' } }, scope())
  assert.equal(denied.kind === 'completed' && denied.successful, false)
  assert.equal(entries.length, 1)
})

const scope = (ownerId = identity.ownerId) => ({ identity: { ...identity, ownerId }, roundId: 'round-1', signal: new AbortController().signal,
  resolution: null, execute: async () => { throw new Error('不可调用宿主 Shell') } })

test('send_item 通过生产工具注册器按授权 owner 解析文件并返回可投递产物', async () => {
  let authorized = true
  const resolvedOwners: string[] = []
  const sendFile = createScheduledSendFileTool(async (current, source) => {
    resolvedOwners.push(current.ownerId)
    assert.deepEqual(source, { key: 'file', value: '/personal/合成报告.txt' })
    return { file_path: '/personal/合成报告.txt', name: '合成报告', ext: 'txt', size_bytes: 4 }
  }, { open: async () => { throw new Error('文件路径不应请求 URL') }, stage: async () => { throw new Error('文件路径不应暂存') } })
  const registry = createAgentToolRegistry({ core: {} as SqlDataRuntime, sendFile,
    authorize: async (current, name) => authorized && current.ownerId === identity.ownerId && name === 'send_item' })
  assert.ok((await registry.capabilities(identity)).some(item => item.name === 'send_item'))
  const result = await registry.tools.dispatch({ id: 'send-1', name: 'send_item', input: { file: '/personal/合成报告.txt' } }, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') {
    assert.equal(result.successful, true)
    assert.deepEqual(result.artifact, { file_path: '/personal/合成报告.txt', name: '合成报告', ext: 'txt', size_bytes: 4 })
    assert.deepEqual(result.value, { ok: true, message: '已准备好附件，将随本轮结果尝试投递，是否送达以后续回执为准。' })
  }
  assert.deepEqual(resolvedOwners, [identity.ownerId])
  authorized = false
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'send_item'), false)
  const denied = await registry.tools.dispatch({ id: 'send-2', name: 'send_item', input: { file: '/personal/合成报告.txt' } }, scope())
  assert.equal(denied.kind, 'completed')
  if (denied.kind === 'completed') { assert.equal(denied.successful, false); assert.equal(denied.executed, false) }
  assert.deepEqual(resolvedOwners, [identity.ownerId])
})

test('画布批处理只有 Host 注入持久确认与事务 claim 后才向模型注册', async () => {
  let allowed = true
  const options = { core: {} as SqlDataRuntime, authorize: async (_identity: typeof identity, name: string) => allowed && name === 'canvas_batch' }
  const absent = createAgentToolRegistry(options)
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'canvas_batch'), false)
  const confirmation = { gate: {} as CanvasBatchConfirmationPort['gate'], claim: async () => false }
  const batch: CanvasBatchPort = {
    confirmation,
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const registry = createAgentToolRegistry({ ...options, canvasBatch: batch })
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_batch'), true)
  allowed = false
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_batch'), false)
})

test('独立画布便笺删除仅在 Host 提供持久确认与事务 claim 时注册', async () => {
  let allowed = true
  const options = { core: {} as SqlDataRuntime, authorize: async (_identity: typeof identity, name: string) => allowed && name === 'canvas_delete_note' }
  assert.equal((await createAgentToolRegistry(options).capabilities(identity)).some(item => item.name === 'canvas_delete_note'), false)
  const port: CanvasDeleteNotePort = {
    confirmation: { gate: {} as CanvasBatchConfirmationPort['gate'], claim: async () => false },
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const registry = createAgentToolRegistry({ ...options, canvasDeleteNote: port })
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_delete_note'), true)
  allowed = false
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_delete_note'), false)
})

test('画布关系断开仅在 Host 提供持久确认与事务 claim 时注册', async () => {
  let allowed = true
  const options = { core: {} as SqlDataRuntime, authorize: async (_identity: typeof identity, name: string) => allowed && name === 'canvas_disconnect' }
  assert.equal((await createAgentToolRegistry(options).capabilities(identity)).some(item => item.name === 'canvas_disconnect'), false)
  const port: CanvasDisconnectPort = {
    confirmation: { gate: {} as CanvasBatchConfirmationPort['gate'], claim: async () => false },
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const registry = createAgentToolRegistry({ ...options, canvasDisconnect: port })
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_disconnect'), true)
  allowed = false
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_disconnect'), false)
})

test('画布级联删除仅在 Host 提供持久确认与事务 claim 时注册', async () => {
  let allowed = true
  const options = { core: {} as SqlDataRuntime, authorize: async (_identity: typeof identity, name: string) => allowed && name === 'canvas_delete' }
  assert.equal((await createAgentToolRegistry(options).capabilities(identity)).some(item => item.name === 'canvas_delete'), false)
  const port: CanvasDeletePort = {
    confirmation: { gate: {} as CanvasBatchConfirmationPort['gate'], claim: async () => false },
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const registry = createAgentToolRegistry({ ...options, canvasDelete: port })
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_delete'), true)
  allowed = false
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'canvas_delete'), false)
})

test('日历事件删除仅在 Host 注入持久确认与事务 claim 后注册', async () => {
  let allowed = true
  const options = { core: {} as SqlDataRuntime, authorize: async (_identity: typeof identity, name: string) => allowed && name === 'delete_event' }
  assert.equal((await createAgentToolRegistry(options).capabilities(identity)).some(item => item.name === 'delete_event'), false)
  const port: CalendarDeletePort = {
    confirmation: { gate: {} as CalendarDeleteConfirmationPort['gate'], claim: async () => false },
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const registry = createAgentToolRegistry({ ...options, calendarDelete: port })
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'delete_event'), true)
  allowed = false
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'delete_event'), false)
})

test('日历事件创建仅在 Host 注入 Core 日历创建和提醒目标端口后注册', async () => {
  const absent = fixture(false, false, false)
  absent.grant('create_event')
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'create_event'), false)
  const port: CalendarEventCreateToolPort = {
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const enabled = fixture(false, false, false, undefined, undefined, undefined, { calendarCreate: port })
  enabled.grant('create_event')
  assert.equal((await enabled.capabilities(identity)).some(item => item.name === 'create_event'), true)
  enabled.revoke('create_event')
  assert.equal((await enabled.capabilities(identity)).some(item => item.name === 'create_event'), false)
})

test('日历事件更新只有在Host注入owner目标查询与Core写端口后注册', async () => {
  const absent = fixture(false, false, false)
  absent.grant('update_event')
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'update_event'), false)
  const port: CalendarEventUpdateToolPort = {
    async apply() { return { kind: 'completed', successful: false, mutated: false, value: { error: '未执行' } } },
    async reconcile() { return { kind: 'unknown' } },
  }
  const enabled = fixture(false, false, false, undefined, undefined, undefined, { calendarUpdate: port })
  enabled.grant('update_event')
  assert.equal((await enabled.capabilities(identity)).some(item => item.name === 'update_event'), true)
  enabled.revoke('update_event')
  assert.equal((await enabled.capabilities(identity)).some(item => item.name === 'update_event'), false)
})

test('http_get 缺少可信网络端口时不注册，注入后使用认证 owner 且撤权后不请求', async () => {
  const absent = fixture(false, false, false)
  absent.grant('http_get')
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'http_get'), false)
  let observed: unknown
  const enabled = fixture(false, false, false, undefined, undefined, undefined, { httpGet: { async get(input) {
    observed = input
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('合成正文') }
  } } })
  enabled.grant('http_get')
  assert.equal((await enabled.capabilities(identity)).some(item => item.name === 'http_get'), true)
  const call = { id: 'web', name: 'http_get', input: { url: 'https://public.example.test' } }
  const result = await enabled.tools.dispatch(call, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') assert.deepEqual(result.value, {
    status: 200, url: 'https://public.example.test', content_type: 'text/plain', body: '合成正文', truncated: false, total_chars: 4,
  })
  assert.deepEqual(observed, { ownerId: identity.ownerId, url: 'https://public.example.test', maxChars: 4000 })
  enabled.revoke('http_get')
  const denied = await enabled.tools.dispatch(call, scope())
  if (denied.kind === 'completed') assert.equal(denied.executed, false)
  else assert.fail('撤权后不能执行')
  assert.deepEqual(observed, { ownerId: identity.ownerId, url: 'https://public.example.test', maxChars: 4000 })
})

test('历史搜索仅在完整可信搜索端口注入且授权时开放', async () => {
  let allowed=true
  const options={core:{} as SqlDataRuntime,authorize:async()=>allowed}
  assert.equal((await createAgentToolRegistry(options).capabilities(identity)).some(item=>item.name==='search_conversations'),false)
  const registry=createAgentToolRegistry({...options,conversationSearch:{recent:async()=>[],search:async()=>[],resolve:async()=>null}})
  const call={id:'history',name:'search_conversations',input:{query:'合成查询'}}
  assert.match(JSON.stringify(await registry.tools.dispatch(call,scope())),/没找到/)
  allowed=false
  assert.match(JSON.stringify(await registry.tools.dispatch(call,scope())),/没有权限/)
})

test('Memory 搜索仅在 Host 注入可信 RAG 服务后注册并向其传入运行身份', async () => {
  let allowed = true
  const options = { core: {} as SqlDataRuntime, authorize: async (_identity: typeof identity, name: string) => allowed && name === 'search_memory' }
  const absent = createAgentToolRegistry(options)
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'search_memory'), false)
  let observed: unknown
  const registry = createAgentToolRegistry({ ...options, memorySearch: { async search(current, request) {
    observed = { current, request }
    return { query: request.query, results: [], has_more: false }
  } } })
  assert.equal((await registry.capabilities(identity)).some(item => item.name === 'search_memory'), true)
  const result = await registry.tools.dispatch({ id: 'memory', name: 'search_memory', input: { query: '合成词', owner_id: '伪造 owner' } }, scope())
  assert.equal(result.kind, 'completed')
  assert.deepEqual(observed, { current: identity, request: { query: '合成词', owner_id: '伪造 owner' } })
  allowed = false
  const denied = await registry.tools.dispatch({ id: 'denied-memory', name: 'search_memory', input: { query: '合成词' } }, scope())
  assert.equal(denied.kind, 'completed')
  if (denied.kind === 'completed') assert.equal(denied.executed, false)
})

test('普通问题仅在 Host 显式开放且授权时注册并进入等待', async () => {
  let allowed=true
  const options={core:{} as SqlDataRuntime,authorize:async()=>allowed}
  const absent=createAgentToolRegistry(options)
  assert.equal((await absent.capabilities(identity)).some(item=>item.name==='ask_user'),false)
  let authorization: 'disabled'|'already_authorized'|'available'='available'
  const registry=createAgentToolRegistry({...options,askUser:{async authorization(){return authorization}}})
  const call={id:'ask',name:'ask_user',input:{kind:'choice',title:'请选择',body:'',options:[]}}
  const result=await registry.tools.dispatch(call,scope())
  assert.equal(result.kind,'waiting')
  const grantCall={id:'ask-grant',name:'ask_user',input:{kind:'choice',authorization:'user_sandbox',title:'授权',body:'',options:[]}}
  assert.equal((await registry.tools.dispatch(grantCall,scope())).kind,'waiting')
  authorization='already_authorized'
  const already=await registry.tools.dispatch(grantCall,scope())
  assert.equal(already.kind==='completed' && already.successful,true)
  authorization='disabled'
  const disabled=await registry.tools.dispatch(grantCall,scope())
  assert.equal(disabled.kind==='completed' && disabled.successful,false)
  allowed=false
  const denied=await registry.tools.dispatch(call,scope())
  assert.equal(denied.kind==='completed' && denied.executed,false)
})

test('链接按钮只在可信能力与授权齐全时开放并可恢复 Web artifact', async () => {
  let allowed = true
  const options = { core: {} as SqlDataRuntime, authorize: async () => allowed }
  const absent = createAgentToolRegistry(options)
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'send_link_buttons'), false)
  const registry = createAgentToolRegistry({ ...options, linkButtons: createWebLinkButtonDeliveryPort(async current => current.ownerId === identity.ownerId) })
  const call = { id:'button', name:'send_link_buttons', input:{message:'入口',buttons:[{id:'a',label:'查看',url:'https://example.test/'}]} }
  assert.equal((await registry.capabilities(identity)).some(item => item.name === call.name), true)
  const result = await registry.tools.dispatch(call, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') assert.deepEqual(result.artifact, {kind:'link_buttons',...call.input})
  assert.deepEqual(await registry.tools.reconcile(call,{...identity,roundId:'round-1'}),result)
  allowed = false
  const denied = await registry.tools.dispatch(call,scope())
  assert.equal(denied.kind === 'completed' && denied.executed, false)
})

test('定时任务仅在可信查询端口与权限齐全时开放，撤权后不查询', async () => {
  const absent = fixture()
  absent.grant('list_scheduled_tasks')
  assert.equal((await absent.capabilities(identity)).some(item => item.name === 'list_scheduled_tasks'), false)
  let reads = 0
  const enabled = fixture(false, false, false, undefined, { list: async current => {
    reads++
    return [{ id: 1, name: current.ownerId }]
  } })
  enabled.grant('list_scheduled_tasks')
  assert.equal((await enabled.capabilities(identity)).some(item => item.name === 'list_scheduled_tasks'), true)
  const result = await enabled.tools.dispatch({ id: 'list', name: 'list_scheduled_tasks', input: { owner_id: '伪造' } }, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') assert.deepEqual(result.value, [{ id: 1, name: identity.ownerId }])
  enabled.revoke('list_scheduled_tasks')
  const denied = await enabled.tools.dispatch({ id: 'denied', name: 'list_scheduled_tasks', input: {} }, scope())
  if (denied.kind === 'completed') assert.equal(denied.executed, false)
  else assert.fail('撤权后不能执行')
  assert.equal(reads, 1)
})

test('技能通过可信 Markdown 注册，缺少能力或撤销授权时不能调用', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-skill-registry-'))
  try {
    const path = join(directory, 'example.md')
    await writeFile(path, '---\nname: 合成技能\ndescription: 示例\n---\n技能正文')
    const definitions = await createBuiltinSkillDefinitions([{ name: 'example.md', read: () => readFile(path, 'utf8') }], new AbortController().signal)
    const skills = createSkillRegistry({ skills: definitions, authorize: async (current) => current.ownerId === identity.ownerId })
    const absent = fixture()
    absent.grant('use_skill')
    assert.equal((await absent.capabilities(identity)).some(item => item.name === 'use_skill'), false)
    const f = fixture(false, false, false, { skills, origin: async () => ({ source: 'builtin' }) })
    f.grant('use_skill')
    assert.equal((await f.capabilities(identity)).some(item => item.name === 'use_skill'), true)
    const result = await f.tools.dispatch({ id: 'skill', name: 'use_skill', input: { id: 'S1' } }, scope())
    assert.equal(result.kind, 'completed')
    if (result.kind === 'completed') {
      assert.equal(result.successful, true)
      assert.equal((result.value as { skill_name: string }).skill_name, '合成技能')
      assert.equal((result.value as { content: string }).content, '技能正文')
    }
    const other = await f.tools.dispatch({ id: 'other', name: 'use_skill', input: { id: 'S1' } }, scope('00000000-0000-4000-8000-000000000002'))
    assert.equal(JSON.stringify(other).includes('技能正文'), false)
    f.revoke('use_skill')
    const denied = await f.tools.dispatch({ id: 'denied', name: 'use_skill', input: { id: 'S1' } }, scope())
    if (denied.kind === 'completed') assert.equal(denied.executed, false)
    else assert.fail('撤权后不能执行')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('注册表按权限暴露并执行真实联系人适配器，跨 owner 数据隔离', async () => {
  const f = fixture()
  assert.deepEqual((await f.capabilities(identity)).map(x => x.name), ['list_contacts', 'create_contact', 'create_project'])
  const made = await f.tools.dispatch({ id: '1', name: 'create_contact', input: { name: '合成联系人' } }, scope())
  assert.deepEqual(made, { kind: 'completed', value: { success: true, contact_id: 1, name: '合成联系人' }, successful: true, mutated: true })
  const own = await f.tools.dispatch({ id: '2', name: 'list_contacts', input: {} }, scope())
  const other = await f.tools.dispatch({ id: '3', name: 'list_contacts', input: {} }, scope('00000000-0000-4000-8000-000000000002'))
  assert.equal(own.kind, 'completed'); assert.equal(other.kind, 'completed')
  if (own.kind === 'completed' && other.kind === 'completed') { assert.equal((own.value as unknown[]).length, 1); assert.deepEqual(other.value, []) }
  f.revoke('create_contact')
  assert.equal((await f.capabilities(identity)).some(x => x.name === 'create_contact'), false)
  const denied = await f.tools.dispatch({ id: '4', name: 'create_contact', input: { name: '不可写入' } }, scope())
  assert.equal(denied.kind, 'completed'); if (denied.kind === 'completed') { assert.equal(denied.successful, false); assert.equal(denied.executed, false) }
  assert.equal(f.records.length, 1)
})

test('未知工具与无效参数不能执行；未知提交结果不暴露异常也不重放', async () => {
  const f = fixture()
  const unknown = await f.tools.dispatch({ id: '1', name: 'shell', input: {} }, scope())
  assert.equal(unknown.kind, 'completed'); if (unknown.kind === 'completed') assert.equal(unknown.executed, false)
  const invalid = await f.tools.dispatch({ id: '2', name: 'create_contact', input: {}, parseError: 'invalid_json' }, scope())
  assert.equal(invalid.kind, 'completed'); if (invalid.kind === 'completed') assert.equal(invalid.executed, false)
  f.failRead()
  const readError = await f.tools.dispatch({ id: 'read', name: 'list_contacts', input: {} }, scope())
  assert.equal(readError.kind, 'completed'); if (readError.kind === 'completed') { assert.equal(readError.executed, true); assert.equal(JSON.stringify(readError).includes('合成私有异常'), false) }
  f.fail()
  const result = await f.tools.dispatch({ id: '3', name: 'create_contact', input: { name: '合成' } }, scope())
  assert.deepEqual(result, { kind: 'unknown' })
  assert.deepEqual(await f.tools.reconcile({ id: '3', name: 'create_contact', input: {} }, { ...identity, roundId: 'round-1' }), { kind: 'unknown' })
  assert.deepEqual(await f.tools.plan!([], identity), { mode: 'serial' })
})

test('项目创建通过现有应用服务，以认证 owner 与 tool call 作为幂等范围', async () => {
  const f = fixture()
  const result = await f.tools.dispatch({ id: 'call-1', name: 'create_project', input: { project_name: '合成项目', start_date: '2026-01-01', deadline: '2026-02-01' } }, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') { assert.equal(result.successful, true); assert.equal((result.value as { name: string }).name, '合成项目') }
})

test('时间工具仅在可信时区端口和授权均存在时开放，并在执行时重新校验', async () => {
  const f = fixture(true)
  assert.equal((await f.capabilities(identity)).some(item => item.name === 'get_current_time'), true)
  const result = await f.tools.dispatch({ id: 'time', name: 'get_current_time', input: {} }, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') assert.equal((result.value as { time: string }).time, '08:00:00')
  f.revoke('get_current_time')
  const denied = await f.tools.dispatch({ id: 'time2', name: 'get_current_time', input: {} }, scope())
  assert.equal(denied.kind, 'completed')
  if (denied.kind === 'completed') assert.equal(denied.executed, false)
  assert.equal((await fixture().capabilities(identity)).some(item => item.name === 'get_current_time'), false)
})

test('Core 联系人更新和项目列表只向获授权的用户开放', async () => {
  const f = fixture()
  assert.equal((await f.capabilities(identity)).some(item => item.name === 'update_contact' || item.name === 'list_projects'), false)
  f.grant('update_contact'); f.grant('list_projects')
  const names = (await f.capabilities(identity)).map(item => item.name)
  assert.ok(names.includes('update_contact'))
  assert.ok(names.includes('list_projects'))
  f.revoke('update_contact')
  const denied = await f.tools.dispatch({ id: 'update', name: 'update_contact', input: { contact_id: 1, notes: '不可写入' } }, scope())
  assert.equal(denied.kind, 'completed')
  if (denied.kind === 'completed') assert.equal(denied.executed, false)
})

test('项目详情缺少可信文件概览时不开放，授权撤销后不能执行', async () => {
  const missing = fixture()
  missing.grant('get_project')
  assert.equal((await missing.capabilities(identity)).some(item => item.name === 'get_project'), false)
  const enabled = fixture(false, true)
  assert.equal((await enabled.capabilities(identity)).some(item => item.name === 'get_project'), true)
  enabled.revoke('get_project')
  const result = await enabled.tools.dispatch({ id: 'project', name: 'get_project', input: { project_id: 1 } }, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') assert.equal(result.executed, false)
})


test('全局搜索仅在共享服务与授权齐全时开放，可信身份与取消信号传入来源，撤权后不再读取', async () => {
  const absent = fixture()
  absent.grant('global_search')
  assert.equal((await absent.capabilities(identity)).some(tool => tool.name === 'global_search'), false)
  const reads: string[] = []
  const search = createGlobalSearchOperations([{ type: 'project', label: '项目', async search(ownerId, query, signal) {
    reads.push(ownerId)
    assert.ok(signal)
    assert.equal(query.perType, 20)
    return [{ id: 7, title: '合成项目' }]
  } }])
  const f = fixture(false, false, false, undefined, undefined, search)
  assert.equal((await f.capabilities(identity)).some(tool => tool.name === 'global_search'), false)
  f.grant('global_search')
  assert.equal((await f.capabilities(identity)).some(tool => tool.name === 'global_search'), true)
  const call = { id: 'search', name: 'global_search', input: { query: '合成', types: ['project'], owner_id: '伪造' } }
  const result = await f.tools.dispatch(call, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') {
    assert.equal(result.successful, true)
    assert.equal((result.value as { total: number }).total, 1)
  }
  assert.deepEqual(reads, [identity.ownerId])
  f.revoke('global_search')
  assert.equal((await f.tools.dispatch(call, scope())).kind, 'completed')
  assert.deepEqual(reads, [identity.ownerId])
})


test('近期待办需日历和时钟同时具备；回收站与近期待办按领域整组启停', async () => {
  const events = { async list() { return [] }, async get() { return null } }
  const missing = fixture(false, false, false, undefined, undefined, undefined, { events })
  missing.grant('get_upcoming')
  assert.equal((await missing.capabilities(identity)).some(tool => tool.name === 'get_upcoming'), false)
  let reads = 0
  const f = fixture(true, false, false, undefined, undefined, undefined, { events, diskTrashTools: [{ definition: { name: 'list_trash', schema: { type: 'function', function: { name: 'list_trash', description: '读取回收站', parameters: { type: 'object', properties: {} } } } }, effect: 'read', validate: data => ({ success: true, data }), async execute() { reads++; return { kind: 'completed', successful: true, mutated: false, value: [] } } }] })
  f.grant('get_upcoming'); f.grant('list_trash')
  assert.ok((await f.capabilities(identity)).some(tool => tool.name === 'get_upcoming'))
  assert.ok((await f.capabilities(identity)).some(tool => tool.name === 'list_trash'))
  f.configure({ groups: { overview: false, trash: false } })
  assert.equal((await f.capabilities(identity)).some(tool => ['get_upcoming', 'list_trash'].includes(tool.name)), false)
  await f.tools.dispatch({ id: 'list', name: 'list_trash', input: {} }, scope())
  assert.equal(reads, 0)
  f.configure({ groups: { overview: true, trash: true } })
  const result = await f.tools.dispatch({ id: 'list', name: 'list_trash', input: {} }, scope())
  assert.equal(result.kind, 'completed')
  if (result.kind === 'completed') assert.deepEqual(result.value, [])
  assert.equal(reads, 1)
})

test('缺共享读取能力或仅apply原型时不开放新增工具', async () => {
  const names=['list_events','list_workspaces','get_workspace','create_workspace','get_dashboard_stats','update_project','set_color','archive_project','add_stage','remove_stage','rename_stage','set_stages','update_stage','note_search','note_get','update_workspace','delete_folder','canvas_list']
  const registry=createAgentToolRegistry({core:{} as SqlDataRuntime,authorize:async()=>true,
    time:{now:()=>new Date('2026-11-15T00:00:00Z'),timezone:async()=> 'UTC'},
    projectMutations:{apply:async()=>{throw new Error('原型不可开放')}}})
  const available=await registry.capabilities(identity)
  assert.equal(available.some(tool=>names.includes(tool.name)),false)
  assert.equal(available.some(tool=>tool.name==='search_tools'),true)
  const result=await registry.tools.dispatch({id:'inspect',name:'search_tools',input:{names:['note_get','add_stage','get_dashboard_stats']}},
    {identity,roundId:'1',signal:new AbortController().signal,resolution:null,execute:async()=>{throw new Error('不执行宿主进程')}})
  assert.equal(result.kind,'completed')
  if(result.kind==='completed'){
    assert.equal(result.successful,true)
    assert.deepEqual(result.value,{results:[],rejected:['note_get','add_stage','get_dashboard_stats']})
  }
})
