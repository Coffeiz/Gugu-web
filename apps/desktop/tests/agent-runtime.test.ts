import { createDesktopContinuationStore } from '../../../packages/core/src/runtime/desktop-continuation.js'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from '../../../packages/core/node_modules/kysely/dist/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../packages/core/src/data/sqlite.js'
import { createDesktopAgentRuns } from '../.tools/agent/runtime.mjs'
import { createDesktopLoopScope } from '../../../packages/core/dist/runtime/desktop-loopscope.js'
import { createDesktopProjectUndoAdapter } from '../../../packages/core/src/runtime/desktop-project-undo.js'
import { createRuntimeUndoTransactionPort, createUndoStateMachine } from '../../../packages/core/src/undo/state-machine.js'
import { createDesktopMemoryFiles } from '../../../packages/core/src/agent/memory/desktop-files.js'
import { readSqliteAgentMemory } from '../../../packages/core/src/agent/memory/sqlite.js'
import { createSqlAgentPendingQueue } from '../../../packages/core/src/agent/sessions/pending-queue.js'
import { createSqliteAgentAdmission } from '../../../packages/core/src/agent/run/sqlite-admission.js'
import { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } from '../../../packages/core/src/agent/run/sqlite-store.js'
import type { CanonicalRunContext, RunCheckpoint } from '../../../packages/core/src/agent/models.js'
import { createDesktopAgentSession } from '../../../packages/core/src/agent/sessions/desktop.js'
import { createFirstTurnTitleWriter } from '../../../packages/core/src/agent/sessions/title.js'
import { createDesktopAgentEventReader } from '../../../packages/core/src/runtime/desktop-agent-events.js'
import { stableJson } from '../../../packages/core/dist/agent/context/history/canonical-history.js'
import { createDesktopAppearanceService } from '../../../packages/core/src/preferences/desktop-appearance.js'
import { createKyselyPreferenceDocumentStore } from '../../../packages/core/src/preferences/document-store.js'

describe('Desktop Agent Run 真实本机 Provider 接线', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

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
    expect(spans.map(span => span.kind)).toEqual(expect.arrayContaining(['context', 'tool', 'output']))
    expect(spans.some(span => ['llm', 'provider'].includes(span.kind) && JSON.stringify(span.input).includes('测试群消息'))).toBe(true)
    expect(spans.flatMap(span => span.attributes.request_timings ?? [])
      .some(timing => Number.isFinite(timing.firstVisibleTokenMs))).toBe(true)
    const { rows: speakers } = await sql`SELECT platform_user_id,platform_user_name FROM conversation_messages
      WHERE session_id=${session.id} AND client_message_id='synthetic-group'`.execute(runtime.db)
    expect(speakers).toEqual([{ platform_user_id: 'synthetic-member', platform_user_name: '小北' }])
    expect(requests.length).toBeGreaterThan(0)
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
    expect(requests).toHaveLength(2)
    expect('tools' in JSON.parse(requests[1]!) as object).toBe(false)
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
    expect(requests).toHaveLength(3)
    expect(JSON.parse(requests[2]!).stream).not.toBe(true)
    hangReflection = true
    const thirdSession = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '退出反思测试'))
    const { run_id: interruptedRun } = await runs.start(thirdSession.id, '测试退出', 'desktop-reflection-close', config)
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
