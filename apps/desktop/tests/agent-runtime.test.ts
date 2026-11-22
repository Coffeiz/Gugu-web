import { loadSqliteAgentRunSecret } from '../../../packages/core/src/agent/run/sqlite-secret.js'
import { desktopFileReferenceKey } from '../../../packages/core/src/agent/sessions/desktop-references.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createDesktopContinuationStore } from '../../../packages/core/src/runtime/desktop-continuation.js'
import { createServer, type Server } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from '../../../packages/core/node_modules/kysely/dist/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../packages/core/src/data/sqlite.js'
import { createDesktopAgentRuns } from '../.tools/agent/runtime.mjs'
import { admitDesktopImEvent, prepareDesktopImEvent, recordDesktopImGroupMessage } from '../../../packages/core/src/im/desktop-inbox.js'
import { resolveImActor } from '../../../packages/core/src/im/access.js'
import { createDesktopLoopScope } from '../../../packages/core/dist/runtime/desktop-loopscope.js'
import { createDesktopProjectUndoAdapter } from '../../../packages/core/src/runtime/desktop-project-undo.js'
import { createRuntimeUndoTransactionPort, createUndoStateMachine } from '../../../packages/core/src/undo/state-machine.js'
import { desktopScheduleImConnection, type DesktopScheduleImTarget } from '../../../packages/core/src/scheduled-tasks/desktop-im.js'
import { createDesktopMemoryFiles } from '../../../packages/core/src/agent/memory/desktop-files.js'
import { readSqliteAgentMemory } from '../../../packages/core/src/agent/memory/sqlite.js'
import { createSqlAgentPendingQueue } from '../../../packages/core/src/agent/sessions/pending-queue.js'
import { createSqliteAgentAdmission } from '../../../packages/core/src/agent/run/sqlite-admission.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from '../../../packages/core/src/agent/run/sqlite-store.js'
import type { CanonicalRunContext, RunCheckpoint } from '../../../packages/core/src/agent/models.js'
import { createDesktopAgentSession, listDesktopAgentSessions, readDesktopAgentHistoryPage } from '../../../packages/core/src/agent/sessions/desktop.js'
import { createFirstTurnTitleWriter } from '../../../packages/core/src/agent/sessions/title.js'
import { createDesktopAgentEventReader } from '../../../packages/core/src/runtime/desktop-agent-events.js'
import { stableJson } from '../../../packages/core/dist/agent/context/history/canonical-history.js'
import { createLocalPreferenceTextFiles } from '../../../packages/core/src/preferences/text-files.js'
import { desktopAgentPreference } from '../../../packages/core/src/preferences/desktop-agent.js'
import { createDesktopAppearanceService } from '../../../packages/core/src/preferences/desktop-appearance.js'
import { createKyselyPreferenceDocumentStore } from '../../../packages/core/src/preferences/document-store.js'

describe('Desktop Agent Run 真实本机 Provider 接线', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

  it('remember 写入后下一个 Run 保持固定前缀，快照过期后加载新记忆', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-memory-prefix-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const rememberText = '合成偏好：使用晨间阅读记录'
    const requests: Array<{ system: unknown; tools: unknown; messages: Array<{ role: string; content: unknown }> }> = []
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ content: [{ type: 'text', text: '合成前缀回归' }], stop_reason: 'end_turn' }))
        return
      }
      requests.push(body)
      const call = requests.length === 1
      const block = call
        ? { type: 'tool_use', id: 'synthetic-remember', name: 'remember', input: { target: 'pattern', text: rememberText } }
        : { type: 'text', text: '合成回复' }
      const events = [
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
    const loopScope = createDesktopLoopScope(process.env, runtime.db, ownerId)
    const runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async method => {
      if (method === 'agent.tools.policy') return { disabledTools: [] }
      if (method === 'agent.log.append') return null
      if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
      if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
      if (method.endsWith('.available')) return false
      throw new Error('未预期的宿主请求')
    }, undefined, loopScope?.observation)
    cleanups.push(async () => {
      await runs.close()
      await loopScope?.close()
      await runtime.close()
      await new Promise<void>(resolve => provider.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    const preferences = createDesktopAppearanceService(createKyselyPreferenceDocumentStore(runtime.db, 'sqlite'))
    await preferences.update(ownerId, { toolInjectionMode: 'full' })
    const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成前缀回归'))
    const read = createDesktopAgentEventReader(runtime.db, path, ownerId)
    async function send(text: string, clientId: string) {
      const { run_id: runId } = await runs.start(session.id, text, clientId, {
        provider: 'local', api_format: 'anthropic', base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512, web_search_enabled: false,
      })
      await expect.poll(async () => (await read(session.id, runId, 0)).status).toBe('completed')
    }
    function prefix(requestIndex: number) {
      const message = requests[requestIndex]?.messages.find(message => JSON.stringify(message.content).includes('[system-reminder]'))
      expect(message).toBeDefined()
      return message
    }
    await send('合成记忆写入', 'synthetic-remember-run')
    expect(requests).toHaveLength(2)
    const memory = await readSqliteAgentMemory(runtime.db, ownerId, '', new AbortController().signal)
    expect(memory.memory.pattern).toContain(rememberText)

    await send('合成记忆续聊', 'synthetic-next-run')
    const previous = requests[1]!
    const next = requests[2]!
    expect(next.system).toEqual(previous.system)
    expect(next.tools).toEqual(previous.tools)
    expect(JSON.stringify(next.messages.slice(0, previous.messages.length))).toBe(JSON.stringify(previous.messages))
    expect(JSON.stringify(prefix(2))).not.toContain(rememberText)

    await sql`UPDATE conversation_sessions SET snapshot_expires_at='1970-01-01T00:00:00.000Z' WHERE id=${session.id}`.execute(runtime.db)
    await send('合成记忆快照重建', 'synthetic-rebuild-run')
    expect(JSON.stringify(prefix(3))).toContain(rememberText)
  })

  it('桌面简介模式搜索并调用工具，关闭运行时正常提交最终回复', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-run-shutdown-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const providerRequests: Record<string, unknown>[] = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(Buffer.from(chunk)))
      request.once('end', () => {
        providerRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        const call = [
          { name: 'search_tools', arguments: JSON.stringify({ query: 'get_current_time' }) },
          { name: 'call_tool', arguments: JSON.stringify({ tool_name: 'get_current_time', arguments: {} }) },
          { name: 'search_tools', arguments: JSON.stringify({ query: 'send_email' }) },
        ][providerRequests.length - 1]
        const delta = call ? { tool_calls: [{ index: 0, id: `synthetic-${call.name}`, type: 'function', function: call }] }
          : { content: '收尾测试' }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    let shutdown: Promise<void> | undefined
    const runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async (method, params) => {
      if (method === 'agent.tools.policy') return { disabledTools: [
        'delete_file', 'delete_folder', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete',
      ] }
      if (method === 'agent.log.append') {
        if (providerRequests.length >= 4 && !params.diagnostic && JSON.parse(String(params.line)).event === 'agent.provider.round_result')
          shutdown ??= runs.close()
        return null
      }
      if (method === 'agent.search.deep_research.available' || method === 'agent.search.similar_image_search.available') return false
      if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
      if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
      throw new Error('未预期的宿主请求')
    })
    cleanups.push(async () => {
      await (shutdown ?? runs.close())
      await runtime.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成本机 Provider 未监听')
    const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '停机测试'))
    const machineTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const preferenceTimezone = machineTimezone === 'Asia/Tokyo' ? 'Asia/Shanghai' : 'Asia/Tokyo'
    await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(runtime.db, 'sqlite'))
      .update(ownerId, { timezone: preferenceTimezone })
    const { run_id: runId } = await runs.start(session.id, '测试收尾', 'desktop-run-shutdown', {
      provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512, web_search_enabled: false,
    })
    await expect.poll(() => Boolean(shutdown)).toBe(true)
    await shutdown
    const providerRequest = providerRequests.find(request => Array.isArray(request.tools))
    expect(providerRequest).toBeDefined()
    const offeredTools = Array.isArray(providerRequest?.tools) ? providerRequest.tools as Array<{ function?: { name?: string } }> : []
    const offeredNames = offeredTools.map(tool => tool.function?.name)
    expect(offeredNames).toContain('search_tools')
    expect(offeredNames).not.toContain('get_current_time')
    expect(JSON.stringify(providerRequests[1])).toContain('工具名：get_current_time')
    expect(JSON.stringify(providerRequests[3])).toContain('send_email')
    const timeReply = (providerRequests[2]?.messages as Array<{ tool_call_id?: string; content: unknown }>)
      .find(message => message.tool_call_id === 'synthetic-call_tool')
    const timeContent = Array.isArray(timeReply?.content) ? timeReply.content[0]?.text : timeReply?.content
    expect(JSON.parse(String(timeContent))).toMatchObject({ timezone: machineTimezone })
    expect(offeredNames).not.toEqual(expect.arrayContaining([
      'delete_file', 'delete_folder', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete', 'get_current_time',
    ]))
    expect(offeredNames.length).toBeGreaterThan(0)
    expect(JSON.stringify(providerRequest)).toContain('每批最多同时调用 5 个工具')
    expect(JSON.stringify(providerRequest)).not.toContain('回收站 0 个')
    const page = await createDesktopAgentEventReader(runtime.db, path, ownerId)(session.id, runId, 0)
    expect(page.status).toBe('completed')
    expect(page.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_done', name: 'search_tools', status: 'success' }),
      expect.objectContaining({ type: 'tool_done', name: 'get_current_time', status: 'success' }),
    ]))
    expect(JSON.stringify(page.events)).toContain('收尾测试')
  })

  it('桌面定时指令调用默认模型并使用任务工具授权，不写入会话历史', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-scheduled-run-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const ownerKey = ownerId.replaceAll('-', '')
    await sql`INSERT INTO desktop_agent_memory(user_id,target,body)
      VALUES(${ownerKey},'profile',${JSON.stringify([{ text: '合成画像' }])})`.execute(runtime.db)
    await createDesktopAppearanceService(createKyselyPreferenceDocumentStore(runtime.db, 'sqlite'))
      .update(ownerId, { locale: 'en-US' })
    const memoryRoot = join(directory, 'memory')
    await mkdir(memoryRoot)
    const disk = createDesktopMemoryFiles(runtime.db, memoryRoot, ownerId)
    let groupMemoryEnabled = true
    let imEnabled = true
    const sent: unknown[] = []
    const requests: Record<string, unknown>[] = []
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      requests.push(JSON.parse(Buffer.concat(chunks).toString()))
      const call = requests.length === 1
      const delta = call ? { tool_calls: [{ index: 0, id: 'synthetic-time', type: 'function',
        function: { name: 'get_current_time', arguments: '{}' } }] } : { content: '定时任务已读取当前时间' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成本机 Provider 未监听')
    const runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async (method: string, params) => {
      if (method === 'agent.tools.policy') return { disabledTools: [] }
      if (method === 'agent.memory.resolveEmbedding') return null
      if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: true }
      if (method === 'agent.schedules.im.authorize') return imEnabled ? { groupMemoryEnabled } : null
      if (method === 'agent.schedules.im.deliver') { sent.push(params); return null }
      if (method === 'agent.schedules.model') return {
        provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key: '', model: 'synthetic-scheduled', context_tokens: 256_000, max_tokens: 512,
      }
      throw new Error('未预期的宿主请求')
    }, disk)
    cleanups.push(async () => {
      await runs.close()
      await runtime.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    const result = await runs.runScheduledInstruction({
      id: '1', ownerId, name: '合成定时任务', payload: '读出当前时间', executionMode: 'instruction',
      channels: ['web'], deliveryTargets: {}, authorizedTools: [], emailAttachmentFileIds: [],
      workspaceId: null, filesystemGrantId: null,
    }, true, async () => {})
    expect(result).toEqual({ status: 'success', text: '定时任务已读取当前时间' })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.model).toBe('synthetic-scheduled')
    const prompt = JSON.stringify(requests[0]?.messages)
    expect(prompt).toContain('合成画像')
    expect(prompt).toContain('当前用户界面语言为「English」')
    expect(prompt).toContain('Telegram：已连')
    const offered = (requests[0]?.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)
    expect(offered).toContain('get_current_time')
    expect(offered).not.toContain('shell')
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'synthetic-time' })]))
    expect((await sql`SELECT id FROM conversation_sessions`.execute(runtime.db)).rows).toEqual([])

    const group: DesktopScheduleImTarget = { platform: 'qq', botId: 'synthetic-bot',
      boundUserId: 'synthetic-owner', chatType: 'group', recipient: 'synthetic-group' }
    const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成群聊'))
    await sql`UPDATE conversation_sessions SET chat_type='group' WHERE id=${session.id}`.execute(runtime.db)
    await sql`INSERT INTO desktop_im_sessions(owner_id,platform,connection_id,session_id)
      VALUES(${ownerKey},'qq',${desktopScheduleImConnection(group)},${session.id})`.execute(runtime.db)
    await disk.writeImScope({ owner_user_id: ownerId, platform: 'qq', bot_id: group.botId,
      scope_type: 'group', scope_id: group.recipient }, 'summary.json', JSON.stringify({ text: '合成群概要' }))
    const copiedPrivate: DesktopScheduleImTarget = { platform: 'feishu', botId: 'synthetic-feishu-bot',
      boundUserId: 'ou_synthetic-owner', chatType: 'c2c', recipient: 'ou_synthetic-owner' }
    const runGroup = () => runs.runScheduledInstruction({
      id: '2', ownerId, name: '合成群任务', payload: '汇报群事务', executionMode: 'instruction',
      channels: ['qq', 'feishu', 'web'], deliveryTargets: { qq: group, feishu: copiedPrivate }, authorizedTools: [], emailAttachmentFileIds: [],
      workspaceId: null, filesystemGrantId: null,
      groupScope: { ownerId, platform: 'qq', botId: group.botId, scopeType: 'group', scopeId: group.recipient },
    }, true, async () => {})
    expect((await runGroup()).status).toBe('success')
    expect(sent).toEqual([group, copiedPrivate].map(target => ({ target, text: '定时任务已读取当前时间' })))
    const groupPrompt = JSON.stringify(requests.at(-1)?.messages)
    expect(groupPrompt).toContain('合成群概要')
    expect(groupPrompt).not.toContain('合成画像')
    expect(groupPrompt).not.toContain('当前用户界面语言为「English」')
    groupMemoryEnabled = false
    expect((await runGroup()).status).toBe('success')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('合成群概要')
    expect(JSON.stringify(requests.at(-1)?.tools)).not.toContain('search_memory')
    const privateTarget: DesktopScheduleImTarget = { ...group, chatType: 'c2c', recipient: group.boundUserId }
    expect((await runs.runScheduledInstruction({
      id: '3', ownerId, name: '合成私聊任务', payload: '汇报个人事务',
      channels: ['qq'], deliveryTargets: { qq: privateTarget }, authorizedTools: [], emailAttachmentFileIds: [],
      workspaceId: null, filesystemGrantId: null,
    }, true, async () => {})).status).toBe('success')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('合成画像')
    expect(sent.at(-1)).toMatchObject({ target: privateTarget })
    imEnabled = false
    await expect(runGroup()).rejects.toMatchObject({ code: 'conflict' })
    expect(sent).toHaveLength(5)
  })

  it('已验证群主通过共享工具创建和停用本群任务', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-schedule-group-write-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const target: DesktopScheduleImTarget = {
      platform: 'qq', botId: 'synthetic-app', boundUserId: 'synthetic-owner', chatType: 'group', recipient: 'synthetic-group',
    }
    const connection = { platform: target.platform, connectionId: desktopScheduleImConnection(target) }
    const event = { ...connection, eventKey: 'synthetic-schedule-write', sealedEvent: 'AQ==' }
    await admitDesktopImEvent(runtime.db, ownerId, event)
    const turn = await prepareDesktopImEvent(runtime.db, ownerId, {
      ...connection, chatType: 'group', ownerPlatformUserId: target.boundUserId,
    })
    if (!turn) throw new Error('合成群收件未准备')
    const actor = resolveImActor({ ownerId, botId: target.botId, platform: target.platform, chatType: 'group', chatId: target.recipient,
      platformUserId: target.boundUserId, botMentioned: true, mentionsOtherBot: false,
      speakers: [{ platformUserId: target.boundUserId }],
    }, () => ({ role: 'owner', allowedToolNames: [] }))
    const offered: string[][] = []
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      offered.push((body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name))
      const call = offered.length === 1 ? { name: 'create_scheduled_task', arguments: JSON.stringify({
        schedule_name: '群提醒', schedule_kind: 'cron', cron: '0 9 * * *', instruction: '例会提醒',
        execution_mode: 'reminder', delivery_mode: 'current_group', channels: ['qq'],
      }) } : offered.length === 2 ? { name: 'update_scheduled_task', arguments: JSON.stringify({ task_id: 1, enabled: false }) } : null
      const delta = call ? { tool_calls: [{ index: 0, id: `schedule-${offered.length}`, type: 'function', function: call }] }
        : { content: '已管理群任务' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}

data: [DONE]

`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
    const runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async method => {
      if (method === 'agent.tools.policy') return { disabledTools: [] }
      if (method.endsWith('.available')) return false
      if (method === 'agent.log.append') return null
      if (method === 'agent.im.authorizeGroupTool') return false
      if (method === 'agent.im.readGroupMemoryContext')
        return { actor, groupMemoryEnabled: false, groupOwnerMemoryEnabled: false, memberMemoryEnabled: false }
      if (method === 'agent.schedules.im.authorize') return { groupMemoryEnabled: false, groupHistorySearchEnabled: false }
      throw new Error('未预期的宿主请求')
    })
    cleanups.push(async () => {
      await runs.close()
      await runtime.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    const started = await runs.start(turn.sessionId, '管理本群提醒', turn.clientId, {
      provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512, web_search_enabled: false,
    }, undefined, true, undefined, [], [], undefined, undefined, { id: target.boundUserId, name: '小北' })
    const read = createDesktopAgentEventReader(runtime.db, path, ownerId)
    await expect.poll(async () => (await read(turn.sessionId, started.run_id, 0)).status).toBe('completed')
    expect(offered[0]).toEqual(expect.arrayContaining(['create_scheduled_task', 'update_scheduled_task', 'list_scheduled_tasks']))
    const { rows } = await sql<{ channels: string; delivery_targets: string; enabled: number }>`
      SELECT channels,delivery_targets,enabled FROM scheduled_tasks`.execute(runtime.db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ channels: 'qq', enabled: 0 })
    expect(JSON.parse(rows[0]!.delivery_targets)).toEqual({ qq: target })
  })

  it('桌面 IM 群会话生成回复时只公开时间工具且不读取个人上下文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-group-run-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const requests: Record<string, unknown>[] = []
    const traces: Record<string, unknown>[] = []
    let collectorUnavailable = true
    let failedTraceAttempts = 0
    let sentCalls = false
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (request.url === '/api/collector/runs') {
        if (collectorUnavailable) {
          failedTraceAttempts++
          response.writeHead(503).end()
          return
        }
        traces.push(body)
        response.writeHead(200).end()
        return
      }
      if (request.url?.endsWith('/finish')) {
        response.writeHead(200).end()
        return
      }
      requests.push(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!sentCalls && Array.isArray(body.tools) && body.tools.some((tool: { function?: { name?: string } }) => tool.function?.name === 'get_current_time')) {
        sentCalls = true
        const tool_calls = ['get_current_time', 'list_projects'].map((name, index) => ({
          index, id: `synthetic-call-${index}`, type: 'function', function: { name, arguments: '{}' },
        }))
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      response.end('data: {"choices":[{"delta":{"content":"测试群回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成 Provider 与 Collector 未监听')
    expect(createDesktopLoopScope({ LOOPSCOPE_ENDPOINT: 'http://invalid.example' })).toBeUndefined()
    expect(createDesktopLoopScope({ LOOPSCOPE_ENABLED: 'true', LOOPSCOPE_ENDPOINT: 'file:///invalid' })).toBeUndefined()
    const loopScope = createDesktopLoopScope({
      LOOPSCOPE_ENABLED: 'true', LOOPSCOPE_ENDPOINT: `http://127.0.0.1:${address.port}`,
    })
    const hostCalls: string[] = []
    const runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async method => {
      hostCalls.push(method)
      if (method === 'agent.log.append') return null
      if (method === 'agent.tools.policy') return { disabledTools: [
        'delete_file', 'delete_folder', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete',
      ] }
      if (method.endsWith('.available')) return false
      throw new Error('未预期的宿主请求')
    }, undefined, loopScope?.observation)
    cleanups.push(async () => {
      await runs.close()
      await loopScope?.close()
      await runtime.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    const session = await runtime.db.transaction().execute(async tx => {
      const session = await createDesktopAgentSession(tx, ownerId, '群会话')
      const owner = ownerId.replaceAll('-', '')
      await sql`UPDATE conversation_sessions SET chat_type='group' WHERE id=${session.id} AND user_id=${owner}`.execute(tx)
      await sql`INSERT INTO desktop_im_sessions (owner_id,platform,connection_id,session_id)
        VALUES (${owner},'qq',${'a'.repeat(64)},${session.id})`.execute(tx)
      return session
    })
    const preferenceFiles = createLocalPreferenceTextFiles(directory)
    const preferences = createKyselyPreferenceDocumentStore(runtime.db, 'sqlite')
    await desktopAgentPreference(preferences, preferenceFiles, ownerId, 'personality', { content: '合成个人设定', enabled: true })
    await desktopAgentPreference(preferences, preferenceFiles, ownerId, 'group-personality', { content: '合成群聊设定', enabled: true })
    const { run_id: runId } = await runs.start(session.id, '测试群消息', 'synthetic-group', {
      provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512, web_search_enabled: false,
    }, undefined, true, undefined, [], [], undefined, undefined, { id: 'synthetic-member', name: '小北' })
    const read = createDesktopAgentEventReader(runtime.db, path, ownerId)
    await expect.poll(async () => (await read(session.id, runId, 0)).status).toBe('completed')
    await expect.poll(() => failedTraceAttempts).toBeGreaterThan(0)
    collectorUnavailable = false
    await expect.poll(() => traces.some(trace => trace.status === 'success'), { timeout: 3000 }).toBe(true)
    const trace = traces.find(trace => trace.status === 'success')!
    expect(trace).toMatchObject({
      session_key: `gugu:desktop:${session.id}`, trace_id: runId, source: 'desktop',
      output: { text: '测试群回复' },
    })
    const spans = trace.spans as Array<{ kind: string; input: unknown; attributes: { request_timings?: Array<{ firstVisibleTokenMs?: number }> } }>
    expect(spans).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'context',
      output: expect.objectContaining({
        assembly: expect.objectContaining({
          rag_source: expect.stringMatching(/^(lookup|prepared)$/),
          history_rows: expect.any(Number),
          history_time_calls: expect.any(Number),
          stages_ms: expect.objectContaining({ rag: expect.any(Number), restore_history: expect.any(Number),
            history_time_format: expect.any(Number), assemble_messages: expect.any(Number) }),
        }),
      }),
    })]))
    expect(spans.map(span => span.kind)).toEqual(expect.arrayContaining(['context', 'tool', 'output']))
    expect(spans.some(span => ['llm', 'provider'].includes(span.kind) && JSON.stringify(span.input).includes('测试群消息'))).toBe(true)
    expect(spans.flatMap(span => span.attributes.request_timings ?? [])
      .some(timing => Number.isFinite(timing.firstVisibleTokenMs))).toBe(true)
    const { rows: speakers } = await sql`SELECT platform_user_id,platform_user_name FROM conversation_messages
      WHERE session_id=${session.id} AND client_message_id='synthetic-group'`.execute(runtime.db)
    expect(speakers).toEqual([{ platform_user_id: 'synthetic-member', platform_user_name: '小北' }])
    expect(requests.length).toBeGreaterThan(0)
    expect(JSON.stringify(requests[0])).toContain('合成群聊设定')
    expect(JSON.stringify(requests)).not.toContain('合成个人设定')
    const tools = requests.flatMap(request => Array.isArray(request.tools) ? request.tools : [])
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every(tool => tool.function?.name === 'get_current_time')).toBe(true)
    const toolReplies = requests.flatMap(request => Array.isArray(request.messages) ? request.messages.filter(message => message.role === 'tool') : [])
    expect(toolReplies).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool_call_id: 'synthetic-call-0', content: expect.stringContaining(
        `"timezone":"${Intl.DateTimeFormat().resolvedOptions().timeZone}"`,
      ) }),
      expect.objectContaining({ tool_call_id: 'synthetic-call-1' }),
    ]))
    expect(JSON.stringify(toolReplies.find(reply => reply.tool_call_id === 'synthetic-call-1')?.content)).toContain('工具不存在或未开放')
    expect(hostCalls).not.toContain('agent.im.snapshot')
    expect(hostCalls).not.toContain('agent.files.overview')
    expect((await sql`SELECT 1 FROM desktop_agent_reflection_jobs`.execute(runtime.db)).rows).toEqual([])
  })

  it('被动成员过阈值后使用独立水位，文件失败重试不重发模型或重复落盘', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-passive-reflection-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    const disk = createDesktopMemoryFiles(runtime.db, join(directory, 'data'), ownerId)
    await disk.initialize()
    const connection = { platform: 'qq', connectionId: 'a'.repeat(64) }
    await admitDesktopImEvent(runtime.db, ownerId, { ...connection, eventKey: 'active', sealedEvent: 'AQ==' })
    const turn = await prepareDesktopImEvent(runtime.db, ownerId, { ...connection, chatType: 'group', ownerPlatformUserId: 'synthetic-owner' })
    if (!turn) throw new Error('合成群收件未准备')
    const actor = resolveImActor({ ownerId, botId: 'synthetic-bot', platform: 'qq', chatType: 'group', chatId: 'synthetic-group',
      platformUserId: 'synthetic-owner', botMentioned: true, mentionsOtherBot: false }, () => ({ role: 'owner', allowedToolNames: [] }))
    const requests: string[] = []
    let failDaily = true, memberSummaryWrites = 0, modelResolutions = 0
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      if (JSON.parse(body).stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"choices":[{"delta":{"content":"测试主动回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      } else {
        if (body.includes('合成被动证据')) requests.push(body)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"合成范围摘要","daily":"合成记忆"}' }, finish_reason: 'stop' }] }))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
    const config = { provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512, web_search_enabled: false } as const
    const runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async method => {
      if (method === 'agent.tools.policy') return { disabledTools: [] }
      if (method.endsWith('.available') || method === 'agent.im.authorizeGroupTool') return false
      if (method === 'agent.log.append') return null
      if (method === 'agent.memory.resolveReflectionModel') {
        modelResolutions++
        return config
      }
      if (method === 'agent.im.readGroupMemoryContext') return {
        actor, ownerPlatformUserId: 'synthetic-owner', groupMemoryEnabled: true, groupOwnerMemoryEnabled: false, memberMemoryEnabled: true,
      }
      throw new Error('未预期的宿主请求')
    }, { ...disk, async writeImScope(scope, filename, body) {
      if (scope.scope_type === 'platform-user') {
        if (filename === 'summary.json') memberSummaryWrites++
        if (filename === 'daily.md' && failDaily) throw new Error('模拟日记落盘失败')
      }
      return disk.writeImScope(scope, filename, body)
    } })
    cleanups.push(async () => {
      await runs.close()
      await runtime.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    const started = await runs.start(turn.sessionId, '合成主动消息', turn.clientId, config, undefined, true,
      undefined, [], [], undefined, undefined, { id: 'synthetic-owner', name: '小北' })
    const read = createDesktopAgentEventReader(runtime.db, path, ownerId)
    await expect.poll(async () => (await read(turn.sessionId, started.run_id, 0)).status).toBe('completed')
    await expect.poll(async () => (await sql`SELECT 1 FROM desktop_im_reflection_jobs WHERE scope_type='group'`.execute(runtime.db)).rows.length).toBe(1)
    await prepareDesktopImEvent(runtime.db, ownerId, { ...connection, chatType: 'group', ownerPlatformUserId: 'synthetic-owner' })
    await sql`UPDATE desktop_im_inbox SET state='completed' WHERE event_key='active'`.execute(runtime.db)
    for (let n = 1; n <= 50; n++)
      await recordDesktopImGroupMessage(runtime.db, ownerId, { ...connection, eventKey: n.toString(16).padStart(64, '0'),
        platformUserId: 'passive-member', text: `合成被动证据-${n}:结束` })
    const threshold = await sql`SELECT 1 FROM desktop_im_reflection_thresholds WHERE due_at_ms>${Date.now()}`.execute(runtime.db)
    expect(threshold.rows).toHaveLength(1)
    runs.resumeReflections()
    await expect.poll(() => modelResolutions).toBeGreaterThan(0)
    expect(requests).toHaveLength(0)
    await sql`UPDATE desktop_im_reflection_thresholds SET due_at_ms=0`.execute(runtime.db)
    runs.resumeReflections()
    await expect.poll(async () => (await sql`SELECT 1 FROM desktop_im_reflection_plans WHERE scope_type='platform-user'
      AND payload IS NOT NULL`.execute(runtime.db)).rows.length).toBe(1)
    const memberPosition = sql`SELECT last_sequence FROM desktop_im_reflection_positions WHERE scope_type='platform-user'`
    expect((await memberPosition.execute(runtime.db)).rows).toEqual([])
    expect(memberSummaryWrites).toBe(1)
    const memberRequests = () => requests.filter(body => body.includes('synthetic-group:passive-member'))
    expect(memberRequests()).toHaveLength(1)
    for (let n = 1; n <= 50; n++)
      expect(memberRequests()[0]!.split(`合成被动证据-${n}:结束`)).toHaveLength(2)
    failDaily = false
    runs.resumeReflections()
    const last = (await sql`SELECT MAX(conversation_seq) AS last_sequence FROM conversation_messages
      WHERE platform_user_id='passive-member'`.execute(runtime.db)).rows
    await expect.poll(async () => (await memberPosition.execute(runtime.db)).rows).toEqual(last)
    expect(memberRequests()).toHaveLength(1)
    expect(memberSummaryWrites).toBe(1)
  })

  it('桌面流式回复与反思将记忆写入本机 .agent/memories 文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-agent-run-'))
    const path = join(directory, 'core.db')
    await initializeSqlite(path)
    const { runtime, ownerId } = await openSqliteRuntime(path)
    let server: Server | undefined
    let runs: ReturnType<typeof createDesktopAgentRuns> | undefined
    cleanups.push(async () => {
      await runs?.close()
      await runtime.close()
      if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    })
    const memoryRoot = join(directory, 'Gugu-data')
    const agentDirectory = join(memoryRoot, '.agent', 'memories')
    await mkdir(agentDirectory, { recursive: true })
    await writeFile(join(agentDirectory, 'memory.md'), '用户使用文件维护长期记忆')
    await writeFile(join(agentDirectory, 'daily.md'), '# 已有本机每日记录\n')
    const disk = createDesktopMemoryFiles(runtime.db, memoryRoot, ownerId)
    await disk.initialize()
    expect(await readFile(join(agentDirectory, 'memory.md'), 'utf8')).toBe('用户使用文件维护长期记忆')
    const requests: string[] = []
    let hangReflection = false
    let conflictOnReflection = false
    let reflectionStarted!: () => void
    let reflectionClosed!: () => void
    const startedReflection = new Promise<void>(resolve => { reflectionStarted = resolve })
    const closedReflection = new Promise<void>(resolve => { reflectionClosed = resolve })
    server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (body.includes('根据下面的对话生成一个简短的会话标题')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ choices: [{ message: { content: '中文沟通偏好' }, finish_reason: 'stop' }] }))
          return
        }
        requests.push(body)
        const requestBody = JSON.parse(body) as { stream?: boolean }
        if (hangReflection && !requestBody.stream) {
          response.once('close', reflectionClosed)
          reflectionStarted()
          return
        }
        if (conflictOnReflection && !requestBody.stream) {
          conflictOnReflection = false
          void writeFile(join(agentDirectory, 'summary.json'), '{"text":"生成期间写入的新摘要"}').then(() => {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ choices: [{ message: { content: '{"summary":"不应覆盖的新模型结果"}' }, finish_reason: 'stop' }] }))
          }, error => response.destroy(error))
          return
        }
        const content = !requestBody.stream && requests.length > 1
          ? JSON.stringify({ profile_add: [{ type: 'preference', text: '用户偏好使用中文沟通' }], pattern_add: [],
            pattern_remove: [], profile_remove: [], summary: '正在排查桌面 Agent 接线',
            daily: '用户确认长期偏好使用中文', lens_hint: '明确表达偏好时优先采用该偏好',
            perception: { intent: '闲聊' } })
          : '本机 Provider 已接通'
        if (requestBody.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        } else {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
        }
      })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成本机 Provider 未监听')
    const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '本机 Agent 测试'))
    const runLogs: Record<string, unknown>[] = []
    runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async (method, params) => {
      if (method === 'agent.log.append') {
        if (!params.diagnostic) runLogs.push(JSON.parse(String(params.line)))
        return null
      }
      if (method === 'agent.memory.resolveReflectionModel') return config
      expect(params).toEqual({})
      if (method === 'agent.tools.policy') return { disabledTools: [
        'delete_file', 'delete_folder', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete',
      ] }
      if (method === 'agent.search.similar_image_search.available') return false
      if (method === 'agent.search.deep_research.available') return false
      if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
      if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
      throw new Error('未预期的宿主请求')
    }, disk)

    const text = '我长期偏好用中文沟通，请用一句话确认连接'
    const queue = createSqlAgentPendingQueue(runtime.db, 'sqlite', { isSessionActive: async () => false })
    const queueId = `session-${session.id}`
    await queue.patch(ownerId, queueId, session.id, [{ key: 1, text }], [])
    const { claimToken } = await queue.claim(ownerId, session.id, queueId, 1)
    if (!claimToken) throw new Error('未认领待发送消息')
    const config = {
      provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512,
      web_search_enabled: false,
    }
    const start = (token: string) => runs!.start(session.id, text, 'desktop-agent-client', config,
      undefined, false, undefined, [], [], { key: 1, token })
    await expect(start('invalid-token')).rejects.toThrow('待发送队列认领冲突')
    expect((await queue.readQueue(ownerId, queueId))?.items).toHaveLength(1)
    const { run_id: runId } = await start(claimToken)
    expect(await queue.readQueue(ownerId, queueId)).toBeNull()
    const readEvents = createDesktopAgentEventReader(runtime.db, path, ownerId)
    let page = await readEvents(session.id, runId, 0)
    const until = Date.now() + 10_000
    while (page.status !== 'completed' && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 20))
      page = await readEvents(session.id, runId, 0)
    }

    expect(page.status).toBe('completed')
    expect(runLogs.map(record => record.event)).toEqual(expect.arrayContaining([
      'agent.run.started', 'agent.provider.round_result', 'agent.run.finished',
    ]))
    expect(new Set(runLogs.map(record => record.run)).size).toBe(1)
    expect(JSON.stringify(runLogs)).not.toContain(text)
    expect(JSON.stringify(runLogs)).not.toContain(runId)
    await expect(readEvents(session.id, runId, 0, true)).resolves.toEqual({
      runId, status: 'completed', executionState: 'idle', cursor: page.cursor, hasMore: false, events: [],
    })
    expect(requests[0].includes('我长期偏好用中文沟通，请用一句话确认连接')).toBe(true)
    const message = await runtime.db.selectFrom('conversation_messages').select('content')
      .where('session_id', '=', session.id).where('role', '=', 'assistant').executeTakeFirst()
    expect(message?.content).toContain('本机 Provider 已接通')
    await expect.poll(async () => (await runtime.db.selectFrom('conversation_sessions').select('title')
      .where('id', '=', session.id).executeTakeFirst())?.title).toBe('中文沟通偏好')
    const anchor = await runtime.db.selectFrom('conversation_messages').select('id')
      .where('session_id', '=', session.id).where('role', '=', 'user').executeTakeFirstOrThrow()
    await expect(createFirstTurnTitleWriter(runtime.db, 'sqlite')({
      identity: { ownerId, sessionId: String(session.id), runId },
      anchorMessageId: String(anchor.id), reply: '本机 Provider 已接通',
      async complete() {
        await sql`UPDATE conversation_sessions SET title='手动标题',title_locked=1 WHERE id=${session.id}`.execute(runtime.db)
        return '迟到的自动标题'
      },
    })).resolves.toBe(false)
    expect((await runtime.db.selectFrom('conversation_sessions').select('title')
      .where('id', '=', session.id).executeTakeFirst())?.title).toBe('手动标题')
    expect(page.events.some(event => event.type === 'display_event')).toBe(true)
    const deliveryPage = await readEvents(session.id, runId, 0, false, true)
    expect(deliveryPage.cursor).toBe(page.cursor)
    expect(deliveryPage.events.filter(event => event.type.startsWith('im_'))).toEqual([
      { type: 'im_round_end', sequence: expect.any(Number), text: '本机 Provider 已接通' },
      { type: 'im_final_text', text: '本机 Provider 已接通' },
    ])
    expect(deliveryPage.events.filter(event => !event.type.startsWith('im_'))).toEqual(page.events)
    expect((await readEvents(session.id, runId, deliveryPage.cursor, false, true)).events).toEqual([])
    const streamPage = await readEvents(session.id, runId, 0, false, true, true)
    expect(streamPage.cursor).toBe(page.cursor)
    const streamEvents = streamPage.events.filter(event => event.type === 'im_stream').map(event => event.runEvent)
    expect(streamEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'token', payload: { text: expect.any(String) } }),
      expect.objectContaining({ type: 'final', identity: expect.objectContaining({ runId }),
        payload: { status: 'completed', text: '本机 Provider 已接通' } }),
    ]))


    expect(requests).toHaveLength(1)
    const secondText = '我也偏好简洁的回答'
    const { run_id: secondRun } = await runs.start(session.id, secondText, 'desktop-reflection-batch', config)
    const ageReflection = async (sessionId: number, reflectionRun: string) => {
      const deadline = Date.now() + 5000
      do {
        const queued = await sql`SELECT 1 FROM desktop_agent_reflection_jobs
          WHERE session_id=${sessionId} AND run_id=${reflectionRun} AND status='queued'`.execute(runtime.db)
        if (queued.rows.length) {
          await sql`UPDATE desktop_agent_reflection_jobs SET created_at_ms=${Date.now() - 181_000}
            WHERE session_id=${sessionId} AND status='queued'`.execute(runtime.db)
          runs!.resumeReflections()
          return
        }
        await new Promise(resolve => setTimeout(resolve, 20))
      } while (Date.now() < deadline)
      throw new Error('未找到待处理的反思')
    }
    await ageReflection(session.id, secondRun)
    let reflectionStatus = 'queued'
    let memoryBody: string | undefined
    let reflectionDiagnostic: { attempts: number; last_error: string | null; model_identity: string } | undefined
    const reflectionDeadline = Date.now() + 10_000
    while ((reflectionStatus !== 'completed' || !memoryBody) && Date.now() < reflectionDeadline) {
      const { rows: [job] } = await sql<{ status: string; attempts: number; last_error: string | null; model_identity: string }>`SELECT status,attempts,last_error,model_identity FROM desktop_agent_reflection_jobs
        WHERE user_id=${ownerId.replaceAll('-', '')} AND session_id=${session.id} AND run_id=${runId}`.execute(runtime.db)
      reflectionStatus = job?.status ?? 'missing'
      reflectionDiagnostic = job && { attempts: job.attempts, last_error: job.last_error, model_identity: job.model_identity }
      memoryBody = await disk.readTarget('profile')
      if (reflectionStatus !== 'completed' || !memoryBody) await new Promise(resolve => setTimeout(resolve, 20))
    }
    const expectedModelIdentity = createHash('sha256').update(stableJson(['local', 'openai', `http://127.0.0.1:${address.port}/v1`, 'synthetic'])).digest('hex')
    expect(reflectionStatus).toBe('completed')
    expect(reflectionDiagnostic?.model_identity).toBe(expectedModelIdentity)
    expect(JSON.parse(memoryBody ?? '[]')).toContainEqual(expect.objectContaining({ text: '用户偏好使用中文沟通' }))
    await disk.flush()
    expect(await disk.readTarget('summary')).toContain('正在排查桌面 Agent 接线')
    const { memory } = await readSqliteAgentMemory(runtime.db, ownerId, '桌面 Agent', new AbortController().signal, undefined, disk)
    expect(memory.summary).toContain('正在排查桌面 Agent 接线')
    expect(memory.daily).toContain('用户确认长期偏好使用中文')
    expect(memory.memory).toContain('用户使用文件维护长期记忆')
    expect(memory.stance).toContain('闲聊')
    expect(await disk.readTarget('lens')).toContain('明确表达偏好')
    expect(requests).toHaveLength(3)
    expect('tools' in JSON.parse(requests[2]!) as object).toBe(false)
    expect(requests[2]).toContain(text)
    expect(requests[2]).toContain(secondText)
    expect((await sql`SELECT status FROM desktop_agent_reflection_jobs WHERE run_id=${secondRun}`.execute(runtime.db)).rows)
      .toEqual([{ status: 'completed' }])
    await runs.close()
    await sql`UPDATE desktop_agent_reflection_jobs SET status='queued'
      WHERE user_id=${ownerId.replaceAll('-', '')} AND session_id=${session.id} AND run_id=${runId}`.execute(runtime.db)
    let resolved = 0
    runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, async (method, params) => {
      if (method === 'agent.memory.resolveReflectionModel') {
        expect(params).toEqual({ modelIdentity: expectedModelIdentity, modelId: null })
        resolved++
        return config
      }
      if (method === 'agent.tools.policy') return { disabledTools: [
        'delete_file', 'delete_folder', 'list_trash', 'restore_file', 'restore_folder', 'permanent_delete',
      ] }
      if (method === 'agent.search.deep_research.available' || method === 'agent.search.similar_image_search.available') return false
      if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
      if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
      throw new Error('未预期的宿主请求')
    }, disk)
    runs.resumeReflections()
    const resumedDeadline = Date.now() + 5000
    let status: string | undefined
    while (status !== 'completed' && Date.now() < resumedDeadline) {
      const { rows } = await sql<{ status: string }>`SELECT status FROM desktop_agent_reflection_jobs
        WHERE user_id=${ownerId.replaceAll('-', '')} AND session_id=${session.id} AND run_id=${runId}`.execute(runtime.db)
      status = rows[0]?.status
      if (status !== 'completed') await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(status).toBe('completed')
    expect(resolved).toBe(1)
    expect(requests).toHaveLength(4)
    expect(JSON.parse(requests[3]!).stream).not.toBe(true)
    const conflictSession = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '并发记忆测试'))
    const { run_id: conflictRun } = await runs.start(conflictSession.id, '我长期偏好每周整理资料', 'desktop-reflection-conflict', config)
    conflictOnReflection = true
    await ageReflection(conflictSession.id, conflictRun)
    await expect.poll(async () => (await sql<{ status: string; last_error: string | null }>`
      SELECT status,last_error FROM desktop_agent_reflection_jobs WHERE session_id=${conflictSession.id}
        AND run_id=${conflictRun}`.execute(runtime.db)).rows[0], { timeout: 5_000 })
      .toEqual({ status: 'queued', last_error: 'stale_memory_snapshot' })
    expect(await disk.readTarget('summary')).toContain('生成期间写入的新摘要')
    await sql`UPDATE desktop_agent_reflection_jobs SET status='failed' WHERE run_id=${conflictRun}`.execute(runtime.db)

    hangReflection = true
    const thirdSession = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '退出反思测试'))
    const { run_id: interruptedRun } = await runs.start(thirdSession.id, '测试退出', 'desktop-reflection-close', config)
    await ageReflection(thirdSession.id, interruptedRun)
    await startedReflection
    await runs.close()
    await closedReflection
    const interrupted = await sql`SELECT status,last_error FROM desktop_agent_reflection_jobs
      WHERE user_id=${ownerId.replaceAll('-', '')} AND session_id=${thirdSession.id} AND run_id=${interruptedRun}`.execute(runtime.db)
    expect(interrupted.rows).toEqual([{ status: 'queued', last_error: 'reflection_interrupted' }])

  })
})

it('续接状态随检查点加密提交，重启后按原身份读取并在运行终结时删除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-continuation-'))
  const path = join(directory, 'core.db')
  const secret = 'synthetic-run-key'
  const reference = 'provider:reference'
  const value = { round: 2, areaDigest: 'area', value: { state_kind: 'synthetic-provider-private-state' } }
  try {
    await initializeSqlite(path)
    const first = await openSqliteRuntime(path)
    const { identity, scope, checkpoint } = await (async () => {
      try {
        const { db } = first.runtime
        const session = await db.transaction().execute(tx => createDesktopAgentSession(tx, first.ownerId, '合成会话'))
        const { identity } = await createSqliteAgentAdmission(db).prepare(first.ownerId, { session_id: session.id, message: '合成请求' })
        const scope = { identity, modelIdentity: 'model', accessScopeHash: 'scope' }
        const continuation = createDesktopContinuationStore(db, secret)
        const leases = createSqliteAgentRunLeasePort(db)
        const lease = (await leases.acquire(identity))!
        const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, {
          async writeHistory() {}, persistPrivateContext: continuation.persist,
        })
        const initial = {
          identity, version: 0, sequence: 0, status: 'running', phase: 'provider', context: null,
        } as unknown as RunCheckpoint<CanonicalRunContext>
        await store.create(initial, lease, [])
        await continuation.store.save(scope, reference, value, 300_000)
        expect(await continuation.store.read(scope, reference)).toBeNull()
        const checkpoint = { ...initial, version: 1,
          context: { ...scope, continuationRef: reference } as CanonicalRunContext }
        await store.commit({ identity, lease, expectedVersion: 0, checkpoint, events: [], interactionReceipt: null, history: null })
        await continuation.store.save(scope, 'provider:uncommitted', { ...value, round: 3 }, 300_000)
        expect(await continuation.store.read(scope, reference)).toEqual(value)
        const { rows: [row] } = await sql<{ payload: Uint8Array }>`SELECT payload FROM desktop_agent_continuations`.execute(db)
        expect(Buffer.from(row!.payload).includes('synthetic-provider-private-state')).toBe(false)
        await leases.release(identity, lease)
        return { identity, scope, checkpoint }
      } finally { await first.runtime.close() }
    })()

    const second = await openSqliteRuntime(path)
    try {
      const { db } = second.runtime
      const continuation = createDesktopContinuationStore(db, secret)
      expect(await continuation.store.read(scope, reference)).toEqual(value)
      expect(await continuation.store.read(scope, 'provider:uncommitted')).toBeNull()
      expect(await continuation.store.read({ ...scope, identity: { ...identity, runId: 'another-run' } }, reference)).toBeNull()
      expect(await continuation.store.read({ ...scope, modelIdentity: 'other' }, reference)).toBeNull()
      expect(await continuation.store.read({ ...scope, accessScopeHash: 'revoked' }, reference)).toBeNull()
      const store = createSqliteAgentRunStore<CanonicalRunContext>(db, secret, { async writeHistory() {} })
      const lease = (await createSqliteAgentRunLeasePort(db).acquire(identity))!
      await store.commit({ identity, lease, expectedVersion: 1,
        checkpoint: { ...checkpoint, version: 2, status: 'completed', phase: 'idle' },
        events: [], interactionReceipt: null, history: null })
      expect(await continuation.store.read(scope, reference)).toBeNull()
    } finally { await second.runtime.close() }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('桌面 Agent 项目字段撤销与重做沿用 SQLite Undo 版本校验', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-project-undo-'))
  const path = join(directory, 'core.db')
  let runtime: Awaited<ReturnType<typeof openSqliteRuntime>>['runtime'] | undefined
  try {
    await initializeSqlite(path)
    const opened = await openSqliteRuntime(path)
    runtime = opened.runtime
    const owner = opened.ownerId.replaceAll('-', '')
    const project = await runtime.db.insertInto('projects').values({
      user_id: owner, name: '更新后项目', summary: '摘要', contact_name: null, status: 'active',
      start_date: null, deadline: null, color: '#445566', progress: 20, stages_json: '[]', current_stage: null,
      priority: null, version: 2, archived: 0, done_at: null, created_at: '2026-11-21 00:00:00',
      updated_at: '2026-11-21 00:00:00', deleted_at: null, idempotency_key: null, idempotency_fingerprint: null,
    }).returning('id').executeTakeFirstOrThrow()
    const ref = `project:${project.id}`
    const undoId = 'project-undo-synthetic'
    const contextId = 'agent:41:run-synthetic'
    const snapshot = (name: string, version: number) => ({
      id: Number(project.id), name, summary: '摘要', client: null, status: 'active', start_date: null, deadline: null,
      color: '#445566', progress: 20, stages: [], current_stage: null, priority: null, archived: false,
      done_at: null, version, deleted_at: null,
    })
    await runtime.db.insertInto('undo_operations').values({
      id: undoId, user_id: owner, undo_context_id: contextId, group_id: 'project-undo-group', resource: 'projects',
      action: 'update', target_refs: JSON.stringify([{ kind: 'project', id: Number(project.id) }]),
      before_state: JSON.stringify({ items: { [ref]: snapshot('原项目名', 1) } }),
      after_state: JSON.stringify({ items: { [ref]: snapshot('更新后项目', 2) } }),
      base_versions: JSON.stringify({ [ref]: { version: 1 } }), artifact_refs: '{}', actor_type: 'web',
      status: 'active', created_at: '2026-11-21 00:00:00', undone_at: null, expires_at: null, failure_code: null,
    }).execute()
    const engine = createUndoStateMachine(createRuntimeUndoTransactionPort(runtime), async () => {}, undefined,
      { projects: createDesktopProjectUndoAdapter() })

    const undone = await engine.apply(opened.ownerId, contextId, undoId, 'undo')
    expect(undone.operation.status).toBe('undone')
    expect(await runtime.db.selectFrom('projects').select(['name', 'version']).where('id', '=', Number(project.id)).executeTakeFirst())
      .toEqual({ name: '原项目名', version: 3 })

    const redone = await engine.apply(opened.ownerId, contextId, undoId, 'redo')
    expect(redone.operation.status).toBe('active')
    expect(await runtime.db.selectFrom('projects').select(['name', 'version']).where('id', '=', Number(project.id)).executeTakeFirst())
      .toEqual({ name: '更新后项目', version: 4 })
  } finally {
    await runtime?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['正常交付', '主人 IM 私聊交付', '跨父运行续聊', '收件箱等待', '父取消', '进程重启', '授权文件', ...(process.platform === 'darwin' ? ['父会话确认'] as const : [])] as const)('Desktop 生产 Run 派单 Searcher 后处理%s', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-desktop-searcher-'))
  const path = join(directory, 'core.db')
  const privateIm = mode === '主人 IM 私聊交付'
  const confirmation = mode === '父会话确认'
  const hostShell = (mode === '正常交付' || confirmation) && process.platform === 'darwin'
  const fileMode = mode === '授权文件'
  const fileId = 'path-synthetic-reference'
  const fileKey = desktopFileReferenceKey(fileId)
  const filePath = join(directory, '合成证据.txt')
  await writeFile(filePath, '合成本机证据正文')
  const info = await stat(filePath, { bigint: true })
  await initializeSqlite(path)
  const initial = await openSqliteRuntime(path)
  const { ownerId } = initial
  let runtime = initial.runtime
  let workerProcess: ChildProcess | undefined
  let finishSearcher!: () => void
  const allowFinal = new Promise<void>(resolve => { finishSearcher = resolve })
  let parentRequests = 0
  let childRequests = 0
  let followupRequests = 0
  let followupReplies = 0
  let parentTools: string[] = []
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ content: [{ type: 'text', text: '合成任务' }], stop_reason: 'end_turn' }))
        return
      }
      const child = JSON.stringify(body.system).includes('你是 Searcher')
      let block: Record<string, unknown>
      const messages = JSON.stringify(body.messages)
      if (child && messages.includes('继续核对合成结论')) {
        followupRequests++
        expect(messages).toContain('核对合成资料')
        expect(messages).toContain('合成子任务已经完成')
        expect(messages).not.toContain('父会话专属追问')
        block = { type: 'text', text: '子 Agent 沿用自己的历史完成了续聊' }
      } else if (child) {
        childRequests++
        const toolNames = body.tools.map((tool: { name: string }) => tool.name)
        expect(toolNames).toContain("shell")
        expect(toolNames).not.toContain("read_file")
        await allowFinal
        if (hostShell && childRequests === 1) {
          block = { type: "tool_use", id: "local-read", name: "shell", input: { cwd: directory, command: "cat 合成证据.txt" } }
        } else if (fileMode && childRequests <= 3) {
          const messages = JSON.stringify(body.messages)
          if (messages.includes('合成本机证据正文')) throw new Error('读取前不应加载文件正文')
          if (childRequests > 1 && !messages.includes('合成证据.txt')) throw new Error('搜索未返回授权文件')
          block = childRequests === 1
            ? { type: 'tool_use', id: 'search', name: 'global_search', input: { query: '证据' } }
            : { type: 'tool_use', id: `read-${childRequests}`, name: 'shell', input: { command: 'cat -- ' + (childRequests === 2 ? 'f'.repeat(24) : fileKey) } }
        } else {
          if (hostShell) expect(JSON.stringify(body.messages)).toContain("合成本机证据正文")
          if (fileMode) {
            const messages = JSON.stringify(body.messages)
            if (!messages.includes('文件引用不存在或无权访问') || !messages.includes('合成本机证据正文'))
              throw new Error('文件读取结果与授权不一致')
          }
          block = { type: 'text', text: '合成子任务已经完成' }
        }
      } else if (messages.includes('父会话专属追问')) {
        const { rows: [row] } = await sql<{ child_id: string }>`SELECT child_id FROM agent_subagent_conversations`.execute(runtime.db)
        if (messages.includes('子 Agent 沿用自己的历史完成了续聊')) {
          followupReplies++
          block = { type: 'text', text: '父 Agent 收到续聊结果' }
        } else if (messages.includes('followup-message'))
          block = { type: 'tool_use', id: 'followup-wait', name: 'agent_wait', input: { childId: row!.child_id } }
        else
          block = { type: 'tool_use', id: 'followup-message', name: 'agent_message',
            input: { action: 'send', childId: row!.child_id, message: '继续核对合成结论' } }
      } else if (JSON.stringify(body.messages.at(-1)).includes('合成后续提问')) {
        block = { type: 'text', text: '合成后续回复已完成' }
      } else if (++parentRequests === 1) {
        parentTools = body.tools.map((tool: { name: string }) => tool.name)
        block = { type: 'tool_use', id: 'delegate', name: 'agent_message',
          input: { action: 'start', agentId: 'builtin:searcher', task: '核对合成资料', ...(fileMode ? { resourceRefs: [fileKey] } : {}) } }
      } else if (parentRequests === 2) {
        const { rows: [row] } = await sql<{ child_id: string }>`SELECT child_id FROM agent_subagent_deliveries`.execute(runtime.db)
        if (!row) throw new Error('派单未持久化')
        block = { type: 'tool_use', id: 'wait-child', name: 'agent_wait', input: mode === '收件箱等待' ? {} : { childId: row.child_id } }
      } else {
        if (!JSON.stringify(body.messages).includes('合成子任务已经完成')) throw new Error('父请求缺少 final')
        block = { type: 'text', text: '合成主回复已汇总子任务' }
      }
      const events = [
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn' } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    } catch {
      response.writeHead(500)
      response.end()
    }
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const address = provider.address()
  if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
  const config = { provider: 'local', api_format: 'anthropic', base_url: `http://127.0.0.1:${address.port}/v1`,
    api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512, web_search_enabled: false }
  const hostRequest = async (method: string, params: Record<string, unknown>) => {
    if (method === 'agent.tools.policy') return { disabledTools: [] }
    if (method === 'agent.log.append') return null
    if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
    if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
    if (method === 'agent.files.resolveWorkspaceReference') {
      expect(params.id).toBe(fileId)
      return { path: filePath, fileIdentity: [info.dev, info.ino, info.birthtimeNs].join('.') }
    }
    if (method === 'agent.memory.resolveReflectionModel') return config
    if (method === 'agent.memory.resolveEmbedding') return null
    if (method.endsWith('.available')) return false
    throw new Error('未预期的宿主请求')
  }
  const openRuns = () => createDesktopAgentRuns(runtime, path, ownerId, () => {}, hostRequest)
  let runs: ReturnType<typeof openRuns> | undefined
  async function stopWorker() {
    const worker = workerProcess
    if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
    const exited = once(worker, 'exit')
    worker.kill('SIGKILL')
    await exited
  }
  async function startPausedWorker(sessionId: number, task: string) {
    await sql.raw(`CREATE TRIGGER pause_searcher_before_provider BEFORE UPDATE ON agent_run_checkpoints
      WHEN OLD.phase='idle' AND NEW.phase='provider'
        AND EXISTS(SELECT 1 FROM agent_subagent_executions s WHERE s.child_run_id=NEW.run_id)
      BEGIN SELECT RAISE(IGNORE); END`).execute(runtime.db)
    const script = join(directory, 'searcher-worker.mjs')
    const bundledRuntime = new URL('../.tools/agent/runtime.mjs', import.meta.url).href
    const sqlite = new URL('../../../packages/core/dist/data/sqlite.js', import.meta.url).href
    await writeFile(script, `import { openSqliteRuntime } from ${JSON.stringify(sqlite)}
import { createDesktopAgentRuns } from ${JSON.stringify(bundledRuntime)}
const [path, session, configuration, task] = process.argv.slice(2)
const config = JSON.parse(configuration)
const { runtime, ownerId } = await openSqliteRuntime(path)
const runs = createDesktopAgentRuns(runtime, path, ownerId, () => {}, ${hostRequest.toString()})
await runs.start(Number(session), task, 'synthetic-restarted-subagent', config, undefined, true)
process.stdin.resume()
`)
    workerProcess = spawn(process.execPath, [script, path, String(sessionId), JSON.stringify(config), task], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    await once(workerProcess, 'spawn')
  }
  try {
    const session = await runtime.db.transaction().execute(async tx => {
      const session = await createDesktopAgentSession(tx, ownerId, '合成委派会话')
      if (privateIm) {
        const owner = ownerId.replaceAll('-', '')
        await sql`UPDATE conversation_sessions SET chat_type='c2c' WHERE id=${session.id} AND user_id=${owner}`.execute(tx)
        await sql`INSERT INTO desktop_im_sessions (owner_id,platform,connection_id,session_id)
          VALUES (${owner},'qq',${'a'.repeat(64)},${session.id})`.execute(tx)
      }
      return session
    })
    if (hostShell && !confirmation) await createKyselyPreferenceDocumentStore(runtime.db, 'sqlite').write(ownerId, { automatic_mode_enabled: true })
    let runId: string
    if (mode === '进程重启') {
      await startPausedWorker(session.id, '合成研究')
      await expect.poll(async () => {
        const { rows } = await sql`SELECT 1 FROM agent_subagent_waits w
          JOIN agent_subagent_deliveries d ON d.owner_id=w.owner_id AND d.parent_run_id=w.parent_run_id AND d.child_id=w.child_id
          JOIN agent_run_checkpoints c ON c.run_id=d.child_run_id WHERE c.phase='idle' AND c.status='running'`.execute(runtime.db)
        return rows.length
      }, { timeout: 8000 }).toBe(1)
      const { rows: [before] } = await sql<{ child_run_id: string; parent_run_id: string }>`
        SELECT child_run_id,parent_run_id FROM agent_subagent_deliveries`.execute(runtime.db)
      if (!before) throw new Error('派单未保存')
      runId = before.parent_run_id
      await stopWorker()
      expect(childRequests).toBe(0)
      await sql.raw('DROP TRIGGER pause_searcher_before_provider').execute(runtime.db)
      await sql`UPDATE agent_run_leases SET expires_at_ms=${Date.now() + 60_000}
        WHERE run_id=${before.child_run_id}`.execute(runtime.db)
      // 模拟升级前的未完成派单，只保留原执行身份、租约和 checkpoint。
      await runtime.db.transaction().execute(async tx => {
        await sql`DELETE FROM conversation_messages WHERE id IN (
          SELECT user_message_id FROM agent_run_admissions WHERE run_id=${before.child_run_id}
        )`.execute(tx)
        await sql`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle'
          WHERE active_run_id=${before.child_run_id} AND source='subagent'`.execute(tx)
      })
      await runtime.close()
      runtime = (await openSqliteRuntime(path, { exclusive: true })).runtime
      const restored = await sql`SELECT a.run_id FROM agent_run_admissions a
        JOIN conversation_sessions s ON s.id=a.session_id AND s.user_id=a.user_id AND s.active_run_id=a.run_id
        WHERE a.run_id=${before.child_run_id} AND s.source='subagent'`.execute(runtime.db)
      expect(restored.rows).toEqual([{ run_id: before.child_run_id }])
      runs = openRuns()
      await runs.reconcileInterruptedRuns()
      finishSearcher()
      const read = createDesktopAgentEventReader(runtime.db, path, ownerId)
      await expect.poll(async () => (await read(session.id, runId, 0)).status, { timeout: 8000 }).toBe('completed')
      const { rows } = await sql<{ child_run_id: string; consumed_checkpoint_version: number }>`
        SELECT child_run_id,consumed_checkpoint_version FROM agent_subagent_deliveries`.execute(runtime.db)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.child_run_id).toBe(before.child_run_id)
      expect(rows[0]?.consumed_checkpoint_version).toBeGreaterThan(0)
      expect(childRequests).toBe(1)
      expect(parentRequests).toBe(3)
      return
    }
    runs = openRuns()
    const read = createDesktopAgentEventReader(runtime.db, path, ownerId)
    const start = await runs.start(session.id, '合成研究', 'synthetic-subagent', config, undefined, !privateIm, undefined, [],
      fileMode ? [{ type: 'file', id: fileId, label: '合成证据.txt' }] : [])
    runId = start.run_id
    await expect.poll(async () => (await (mode === '收件箱等待'
      ? sql`SELECT 1 FROM agent_inbox_waits WHERE run_id=${runId}`
      : sql`SELECT 1 FROM agent_subagent_waits WHERE parent_run_id=${runId}`).execute(runtime.db)).rows.length).toBe(1)
    expect(await read(session.id, runId, 0)).toMatchObject({ runId, status: 'running' })
    expect(await read(session.id, undefined, 0, true)).toMatchObject({ runId, status: 'running' })
    expect((await listDesktopAgentSessions(runtime.db, ownerId)).find(row => row.id === session.id))
      .toMatchObject({ isRunning: true })
    expect(parentTools).toContain('agent_message')
    expect(parentRequests).toBe(2)
    if (privateIm) {
      const page = await read(session.id, runId, 0, false, true, true)
      expect(page.events).toContainEqual(expect.objectContaining({ type: 'im_stream',
        runEvent: expect.objectContaining({ type: 'tool_call', payload: {} }) }))
    }
    await expect.poll(() => childRequests).toBe(1)
    if (mode === '父取消') {
      const cancelled = await createSqliteAgentAdmission(runtime.db).requestCancel(ownerId, session.id, runId)
      expect(cancelled.outcome).toBe('requested')
      await runs.notifyCancel(session.id, runId)
      finishSearcher()
      await expect.poll(async () => (await read(session.id, runId, 0)).status).toBe('cancelled')
      expect(parentRequests).toBe(2)
      return
    }
    finishSearcher()
    if (confirmation) {
      const history = () => readDesktopAgentHistoryPage(runtime.db, ownerId, session.id, undefined,
        () => loadSqliteAgentRunSecret(runtime.db, path))
      await expect.poll(async () => (await history()).messages.flatMap(message => message.interactions ?? []).length).toBe(1)
      const prompt = (await history()).messages.flatMap(message => message.interactions ?? [])[0]
      const token = prompt?.options?.find(option => option.id === 'confirm')?.token
      if (!prompt || !token) throw new Error('父会话未收到子 Shell 确认')
      expect(childRequests).toBe(1)
      await expect(runs.respond(session.id, runId, prompt.id, randomUUID(), { token }, config))
        .resolves.toEqual({ runId, awaitingText: false })
    }
    await expect.poll(async () => (await read(session.id, runId, 0)).status, { timeout: 8000 }).toBe('completed')
    if (privateIm) {
      const page = await read(session.id, runId, 0, false, true)
      expect(page.events).toContainEqual({ type: 'im_final_text', text: '合成主回复已汇总子任务' })
      expect(JSON.stringify(page.events)).not.toContain('合成子任务已经完成')
    }
    expect(childRequests).toBe(fileMode ? 4 : hostShell ? 2 : 1)
    expect(parentRequests).toBe(3)
    const consumed = await sql<{ consumed_checkpoint_version: number }>`SELECT consumed_checkpoint_version FROM agent_subagent_deliveries`.execute(runtime.db)
    expect(consumed.rows[0]?.consumed_checkpoint_version).toBeGreaterThan(0)
    if (mode === '跨父运行续聊') {
      await runs.close()
      runs = undefined
      await startPausedWorker(session.id, '父会话专属追问')
      const followupDelivery = sql<{ parent_run_id: string; child_run_id: string; child_id: string }>`
        SELECT d.parent_run_id,d.child_run_id,d.child_id FROM agent_subagent_deliveries d
        JOIN agent_subagent_waits w ON w.owner_id=d.owner_id AND w.parent_run_id=d.parent_run_id AND w.child_id=d.child_id
        JOIN agent_run_checkpoints c ON c.run_id=d.child_run_id
        WHERE d.parent_run_id<>${runId} AND c.phase='idle' AND c.status='running'`
      await expect.poll(async () => (await followupDelivery.execute(runtime.db)).rows.length, { timeout: 8000 }).toBe(1)
      const [followup] = (await followupDelivery.execute(runtime.db)).rows
      if (!followup) throw new Error('续聊派单未保存')
      expect(followupRequests).toBe(0)
      const admission = await sql`
        SELECT a.run_id FROM agent_run_admissions a
        JOIN conversation_sessions s ON s.user_id=a.user_id AND s.id=a.session_id
        JOIN conversation_messages m ON m.session_id=s.id AND m.id=a.user_message_id
        WHERE a.run_id=${followup.child_run_id} AND s.active_run_id=a.run_id AND m.role='user'`.execute(runtime.db)
      expect(admission.rows).toEqual([{ run_id: followup.child_run_id }])
      const [beforeRestart] = (await sql<{ fence: number }>`
        SELECT fence FROM agent_run_leases WHERE run_id=${followup.child_run_id}`.execute(runtime.db)).rows
      await stopWorker()
      await sql`UPDATE agent_run_leases SET expires_at_ms=${Date.now() + 60_000}
        WHERE run_id=${followup.child_run_id}`.execute(runtime.db)
      await sql.raw('DROP TRIGGER pause_searcher_before_provider').execute(runtime.db)
      await runtime.close()
      runtime = (await openSqliteRuntime(path, { exclusive: true })).runtime
      runs = openRuns()
      await runs.reconcileInterruptedRuns()
      const readRecovered = createDesktopAgentEventReader(runtime.db, path, ownerId)
      await expect.poll(async () => (await readRecovered(session.id, followup.parent_run_id, 0)).status, { timeout: 8000 }).toBe('completed')
      expect(JSON.stringify((await readRecovered(session.id, followup.parent_run_id, 0)).events)).toContain('父 Agent 收到续聊结果')
      const [afterRestart] = (await sql<{ fence: number }>`
        SELECT fence FROM agent_run_leases WHERE run_id=${followup.child_run_id}`.execute(runtime.db)).rows
      expect(beforeRestart?.fence).toBeGreaterThan(0)
      expect(afterRestart?.fence).toBeGreaterThan(beforeRestart!.fence)
      await runs.reconcileInterruptedRuns()
      const deliveries = await sql<{ child_id: string; child_run_id: string; consumed_checkpoint_version: number }>`
        SELECT child_id,child_run_id,consumed_checkpoint_version FROM agent_subagent_deliveries`.execute(runtime.db)
      expect(deliveries.rows).toHaveLength(2)
      expect(deliveries.rows.filter(row => row.child_run_id === followup.child_run_id)).toEqual([
        expect.objectContaining({ child_id: followup.child_id, consumed_checkpoint_version: expect.any(Number) }),
      ])
      expect(new Set(deliveries.rows.map(row => row.child_id))).toEqual(new Set([followup.child_id]))
      expect(deliveries.rows.find(row => row.child_run_id === followup.child_run_id)?.consumed_checkpoint_version).toBeGreaterThan(0)
      expect(followupRequests).toBe(1)
      expect(followupReplies).toBe(1)
      const executions = await sql<{ child_session_id: number }>`SELECT child_session_id FROM agent_subagent_executions`.execute(runtime.db)
      expect(executions.rows).toHaveLength(2)
      expect(new Set(executions.rows.map(row => row.child_session_id)).size).toBe(1)
    }
    if (mode === '正常交付') {
      const followup = await runs.start(session.id, '合成后续提问', 'synthetic-followup', config)
      expect(followup.run_id).not.toBe(runId)
      await expect.poll(async () => (await read(session.id, followup.run_id, 0)).status).toBe('completed')
      expect(JSON.stringify((await read(session.id, followup.run_id, 0)).events)).toContain('合成后续回复已完成')
    }
  } finally {
    finishSearcher()
    await stopWorker()
    await runs?.close()
    await runtime.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 25_000)
