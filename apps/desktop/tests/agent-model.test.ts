import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { CoreHost } from '../src/main/core-host.js'
import { DESKTOP_CHANNELS, type DesktopAgentChatEvent } from '@gugu/core/desktop'
import { createDesktopAgentModelService, createDesktopAgentModelStore } from '../src/main/agent/model.js'
import { auxiliaryModelHandlers, createDesktopEmbeddingResolver } from '../src/main/agent/auxiliary-model.js'
import { agentModelHandlers, agentSessionHandlers } from '../src/main/agent/ipc.js'
import { desktopAgentToolPolicy } from '../src/main/agent/tool-policy.js'

const desktopAgentRuntimeModule = fileURLToPath(new URL('../.tools/agent/runtime.mjs', import.meta.url))
const launchCoreHost = (node: string, entry: string, database: string) =>
  CoreHost.launch(node, entry, database, undefined, undefined, undefined, undefined, desktopAgentRuntimeModule)

it('模型列表支持旧版迁移、并发新增、密钥隔离、默认切换及删除', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-model-'))
  const payloads = new Map<string, string>()
  const encryption = {
    async isAsyncEncryptionAvailable() { return true },
    async encryptStringAsync(value: string) {
      const ciphertext = randomBytes(32)
      payloads.set(ciphertext.toString('hex'), value)
      return ciphertext
    },
    async decryptStringAsync(ciphertext: Buffer) {
      return { result: payloads.get(ciphertext.toString('hex'))!, shouldReEncrypt: false }
    },
  }
  let runtime: CoreHost | undefined
  let sentMessages: unknown
  const sentMessageHistory: unknown[] = []
  const embeddingInputs: string[] = []
  let summaryRequests = 0
  let conversationId = 0
  let canvasId = 0
  let skillId = ''
  const conversationResults: unknown[] = []
  const presentedFiles: string[] = []
  const longReply = '长回复。'.repeat(8_000)
  const searches = [
    { prompt: '合成深度研究请求', tool: 'deep_research', args: { query: '合成检索词', max_results: 2 }, hostDefaults: { depth: 'basic' } },
    { prompt: '合成相似图片搜索请求', tool: 'similar_image_search', args: { image_url: 'https://example.com/synthetic.png', max_results: 2 }, hostDefaults: {} },
  ]
  const searchCalls: string[] = []
  let goalRounds = 0
  let knowledgeId: string | undefined
  let toolSchema: unknown
  let memorySearchResult: { content: string | Array<{ text: string }> } | undefined
  let initialMemoryRequest: unknown
  let toolResult: unknown
  const interactionKeys: Array<string | undefined> = []
  let openStream: ServerResponse | undefined
  const calls: Array<{ url?: string; headers: string | undefined; model: string }> = []
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const { model, messages, stream, tools, input } = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    if (request.url === '/v1/embeddings') {
      embeddingInputs.push(input)
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }))
      return
    }
    sentMessages = messages
    if (stream) sentMessageHistory.push(messages)
    if (!stream && JSON.stringify(messages)?.includes('待摘要历史问题')) {
      summaryRequests++
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: '合成会话摘要' }, finish_reason: 'stop' }] }))
      return
    }
    if (model === 'denied-model') {
      calls.push({ url: request.url, headers: request.headers.authorization, model })
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'synthetic-upstream-secret' } }))
      return
    }
    if (!stream && JSON.stringify(messages ?? []).includes('请只回复 OK。')) {
      calls.push({ url: request.url, headers: request.headers.authorization, model })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }))
      return
    }
    if (stream && /测试聊天(?:选模|默认模型)/u.test(JSON.stringify(messages))) {
      calls.push({ url: request.url, headers: request.headers.authorization, model })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      return
    }
    if (stream && JSON.stringify(messages).includes('合成目标中断验收')) {
      openStream = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"合成目标仍在进行"}}]}\n\n')
      return
    }
    if (stream && model === 'test-model') {
      const userIndex = messages.findLastIndex((message: { role: string }) =>
        message.role === 'user' && JSON.stringify(message).includes('【消息正文】'))
      const lastUser = JSON.stringify(messages[userIndex] ?? {})
      const currentTurn = messages.slice(userIndex + 1)
      if (lastUser.includes('合成提醒不可交互删除')) {
        const canDelete = tools?.some((tool: { function?: { name?: string } }) => tool.function?.name === 'delete_scheduled_task')
        const content = canDelete ? '错误地开放删除工具' : '未开放删除工具'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      const search = searches.find(item => lastUser.includes(item.prompt))
      if (search) {
        const result = currentTurn.find((message: { role: string; tool_call_id?: string }) =>
          message.role === 'tool' && message.tool_call_id === 'synthetic-research')
        const frame = result
          ? { choices: [{ delta: { content: JSON.stringify(result).includes('合成研究结果') ? '已取得研究结果' : '研究结果缺失' }, finish_reason: 'stop' }] }
          : { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-research', type: 'function',
            function: { name: 'call_tool', arguments: JSON.stringify({
              tool_name: search.tool, arguments: search.args,
            }) } }] }, finish_reason: 'tool_calls' }] }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
        return
      }
      if (lastUser.includes('合成目标验收')) {
        goalRounds++
        const content = goalRounds === 1 ? '合成目标仍在进行' : '合成目标完成 <!-- GUGU_GOAL_DONE -->'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      const knowledgeTool = lastUser.includes('合成知识写入') ? 'save_knowledge'
        : lastUser.includes('合成知识更新') ? 'update_knowledge'
          : lastUser.includes('合成知识读取') ? 'read_knowledge'
            : lastUser.includes('合成知识删除') ? 'delete_knowledge' : undefined
      if (knowledgeTool) {
        const result = currentTurn.find((message: { role: string; tool_call_id?: string }) =>
          message.role === 'tool' && message.tool_call_id === knowledgeTool)
        const args = knowledgeTool === 'save_knowledge' ? { title: '合成知识标题', content: '合成初始正文' }
          : knowledgeTool === 'update_knowledge' ? { knowledge_id: knowledgeId, content: '合成更新正文' }
            : { knowledge_id: knowledgeId }
        let reply = '合成知识操作失败'
        if (result) {
          const value = JSON.parse(typeof result.content === 'string' ? result.content : result.content[0].text)
          if (knowledgeTool === 'save_knowledge' && value.success === true) knowledgeId = value.id
          if (knowledgeTool === 'read_knowledge' ? JSON.stringify(value).includes('合成更新正文') : value.success === true)
            reply = '合成知识操作完成'
        }
        const delta = result ? { content: reply } : { tool_calls: [{ index: 0, id: knowledgeTool, type: 'function',
          function: knowledgeTool === 'delete_knowledge' ? { name: knowledgeTool, arguments: JSON.stringify(args) }
            : { name: 'call_tool', arguments: JSON.stringify({ tool_name: knowledgeTool, arguments: args }) } }] }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: result ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      const mcpAction = lastUser.includes('合成新增测试服务') ? 'add'
        : lastUser.includes('合成修改测试服务') ? 'update'
          : lastUser.includes('合成删除测试服务') ? 'remove' : undefined
      if (mcpAction) {
        const callId = `synthetic-mcp-${mcpAction}`
        const args = { action: mcpAction, server_name: lastUser.includes('并取消凭据') ? 'synthetic-cancel' : 'synthetic-mcp',
          ...(mcpAction === 'add' ? { endpoint: 'https://mcp.example.test', enabled: false,
            credential_slots: [{ id: 'key', label: '合成凭据', target: 'header', parameter_name: 'Authorization', prefix: 'Bearer ' }] } : {}),
          ...(mcpAction === 'update' ? { tool_allowlist: ['lookup'] } : {}),
        }
        const result = currentTurn.find((message: { role: string; tool_call_id?: string }) =>
          message.role === 'tool' && message.tool_call_id === callId)
        const delta = result ? { content: '合成服务操作结束' } : { tool_calls: [{
          index: 0, id: callId, type: 'function',
          function: { name: 'manage_mcp_servers', arguments: JSON.stringify(args) },
        }] }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: result ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      if (lastUser.includes('合成模型繁忙')) {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'synthetic-retry-detail' } }))
        return
      }
      if (lastUser.includes('合成历史关键词检索') || lastUser.includes('合成历史正文读取') || lastUser.includes('合成联系人查询') || lastUser.includes('合成画布引用检索') || lastUser.includes('合成定时任务查询') || lastUser.includes('合成近期附件查询') || lastUser.includes('合成文件预览') || lastUser.includes('合成用户技能读取') || lastUser.includes('合成内置技能读取') || lastUser.includes('合成通用工具调用') || lastUser.includes('合成未开放工具调用') || lastUser.includes('合成笔记创建') || lastUser.includes('合成画布写入') || lastUser.includes('合成活动创建') || lastUser.includes('合成项目创建') || lastUser.includes('合成技能创建') || lastUser.includes('合成提醒创建') || lastUser.includes('合成提醒更新') || lastUser.includes('合成提醒删除')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const read = lastUser.includes('合成历史正文读取')
        const clients = lastUser.includes('合成联系人查询')
        const placeable = lastUser.includes('合成画布引用检索')
        const schedules = lastUser.includes('合成定时任务查询')
        const recentAttachments = lastUser.includes('合成近期附件查询')
        const presentFile = lastUser.includes('合成文件预览')
        const builtin = lastUser.includes('合成内置技能读取')
        const skill = builtin || lastUser.includes('合成用户技能读取')
        const denied = lastUser.includes('合成未开放工具调用')
        const forwarded = denied || lastUser.includes('合成通用工具调用')
        const note = lastUser.includes('合成笔记创建')
        const canvas = lastUser.includes('合成画布写入')
        const calendar = lastUser.includes('合成活动创建')
        const project = lastUser.includes('合成项目创建')
        const createSkill = lastUser.includes('合成技能创建')
        const createReminder = lastUser.includes('合成提醒创建')
        const updateReminder = lastUser.includes('合成提醒更新')
        const deleteReminder = lastUser.includes('合成提醒删除')
        const name = deleteReminder ? 'delete_scheduled_task' : updateReminder ? 'update_scheduled_task' : createReminder ? 'create_scheduled_task' : createSkill ? 'create_skill' : project ? 'create_project' : calendar ? 'create_event' : canvas ? (canvasId ? 'canvas_create_note' : 'canvas_create') : note ? 'note_create' : forwarded ? 'call_tool' : skill ? 'use_skill' : presentFile ? 'present_file' : recentAttachments ? 'list_recent_attachments' : schedules ? 'list_scheduled_tasks' : placeable ? 'canvas_search_placeable' : clients ? 'list_clients' : read ? 'read_conversation' : 'search_conversations'
        const result = currentTurn.findLast((message: { role: string; tool_call_id?: string }) =>
          message.role === 'tool' && message.tool_call_id === `synthetic-${name}`)
        if (result) conversationResults.push(result.content)
        const frame = result
          ? { choices: [{ delta: { content: '合成历史工具回复' }, finish_reason: 'stop' }] }
          : { choices: [{ delta: { tool_calls: [{ index: 0, id: `synthetic-${name}`, type: 'function',
            function: { name,
              arguments: JSON.stringify(deleteReminder ? { task: '合成 Agent 提醒' } : updateReminder ? {
                task: '合成 Agent 提醒', instruction: '  合成更新后的提醒正文\n',
              } : createReminder ? {
                schedule_name: '合成 Agent 提醒', instruction: '合成提醒正文',
                schedule_kind: 'once', start_at: '2099-09-10T00:00:00Z',
              } : createSkill ? {
                skill_name: '合成 Agent 技能', description_short: '合成摘要', body: '合成 Agent 技能正文',
                managed_by: 'assistant', related_tools: ['get_current_time'],
              } : project ? {
                project_name: '合成 Agent 项目', start_date: '2099-09-10', deadline: '2099-09-13',
              } : calendar
                ? { title: '合成 Agent 日历活动', date: '2099-09-10', all_day: true, reminders: [{ lead_minutes: 10 }] }
                : presentFile ? { file: '/personal/合成预览.png' } : canvas ? (canvasId
                ? { canvas_id: canvasId, content: '合成画布便签正文' }
                : { title: '合成 Agent 画布' }) : note ? { markdown: '# 合成 Agent 笔记\n\n合成笔记正文' } : forwarded ? { tool_name: denied ? 'synthetic_unavailable_tool' : 'get_current_time', arguments: {} } : skill ? { id: builtin ? 'S2' : skillId } : placeable ? { query: '合成上下文项目', types: ['project'] } : clients || schedules || recentAttachments ? {} : read ? { session_id: conversationId } : { query: '待摘要历史问题' }) } }] }, finish_reason: 'tool_calls' }] }
        response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
        return
      }
      const textQuestion = lastUser.includes('合成自由文本问题')
      if (lastUser.includes('合成交互问题') || textQuestion) {
        interactionKeys.push(request.headers.authorization)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const answer = messages.some((message: { role: string; tool_call_id?: string }) =>
          message.role === 'tool' && message.tool_call_id === 'synthetic-interaction-call')
        const frame = answer
          ? { choices: [{ delta: { content: '合成交互已续跑' }, finish_reason: 'stop' }],
            ...(lastUser.includes('合成交互问题压缩') ? { usage: { prompt_tokens: 250000, completion_tokens: 1 } } : {}) }
          : { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-interaction-call', type: 'function',
            function: { name: 'ask_user', arguments: JSON.stringify(textQuestion
              ? { kind: 'question', title: '合成文本问题', body: '请填写合成文本答案' }
              : { kind: 'choice', title: '合成提示', body: '', options: [{ id: 'a', label: '合成选项' }] }) } }] }, finish_reason: 'tool_calls' }] }
        response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
        return
      }
      if (lastUser.includes('合成长回复')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const frame = { choices: [{ delta: { content: longReply }, finish_reason: 'stop' }] }
        response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
        return
      }
      if (lastUser.includes('合成摘要续聊')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"choices":[{"delta":{"content":"合成续聊回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        return
      }
      if (lastUser.includes('合成压缩请求')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end('data: {"choices":[{"delta":{"content":"合成压缩回复"},"finish_reason":"stop"}],"usage":{"prompt_tokens":250000,"completion_tokens":1}}\n\ndata: [DONE]\n\n')
        return
      }
      if (lastUser.includes('合成记忆写入') || lastUser.includes('合成记忆读取') || lastUser.includes('合成记忆删除')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const write = lastUser.includes('合成记忆写入')
        const remove = lastUser.includes('合成记忆删除')
        const callId = write ? 'synthetic-memory-write' : remove ? 'synthetic-memory-remove' : 'synthetic-memory-search'
        const result = currentTurn.findLast((message: { role: string; tool_call_id?: string }) =>
          message.role === 'tool' && message.tool_call_id === callId)
        if (!write && result) memorySearchResult = result
        if (!write && !result) initialMemoryRequest = messages
        const command = write
          ? { name: 'remember', arguments: JSON.stringify({ text: '合成用户偏好晨间阅读', target: 'pattern' }) }
          : remove
            ? { name: 'remember', arguments: JSON.stringify({ remove: ['合成用户偏好晨间阅读'], target: 'pattern' }) }
            : { name: 'search_memory', arguments: JSON.stringify({ query: '晨间阅读', source: 'pattern' }) }
        const frame = !result
          ? { choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function',
            function: command }] }, finish_reason: 'tool_calls' }] }
          : { choices: [{ delta: { content: '合成记忆回复' }, finish_reason: 'stop' }] }
        response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
        return
      }
    }
    if (stream && JSON.stringify(messages).includes('合成网页读取')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const result = messages.find((message: { role: string }) => message.role === 'tool')
      if (result) {
        toolResult = result
        response.end('data: {"choices":[{"delta":{"content":"合成工具执行完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      } else {
        toolSchema = tools
        const frame = { choices: [{ delta: { tool_calls: [{
          index: 0, id: 'synthetic-tool', type: 'function',
          function: { name: 'call_tool', arguments: JSON.stringify({ tool_name: 'http_get', arguments: { url: 'http://127.0.0.1:' + (provider.address() as { port: number }).port } }) },
        }] }, finish_reason: 'tool_calls' }] }
        response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
      }
      return
    }
    if (stream && !/合成(?:流式请求|取消请求)/u.test(JSON.stringify(messages))) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: '未匹配的合成流式请求' } }))
      return
    }
    if (stream) {
      openStream = response
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"合成增量"}}]}\n\n')
      return
    }
    if (request.method === 'GET' && request.url === '/no-catalog/v1/models') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'synthetic-upstream-private' } }))
      return
    }
    const media = Array.isArray(messages?.[0]?.content) ? messages[0].content[1]?.type : undefined
    if (media === 'video_url') {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unsupported video_url' } }))
      return
    }
    calls.push({ url: request.url, headers: request.headers.authorization, model })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.method === 'GET' ? { data: [{ id: 'test-model' }] } : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }))
  })
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const address = provider.address() as { port: number }
    const preset = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model', apiKey: 'synthetic-model-key' }
    const connect = () => agentModelHandlers(createDesktopAgentModelService(createDesktopAgentModelStore(directory, encryption)))[DESKTOP_CHANNELS.agentModel]!
    const request = connect()
    expect(await request({ action: 'get' })).toBeNull()
    const publicPreset = { baseUrl: preset.baseUrl, model: preset.model, provider: 'local', apiFormat: 'openai', contextTokens: 256_000, maxTokens: 51_200 }
    expect(await request({ action: 'save', preset })).toEqual(publicPreset)
    const encrypted = await readFile(join(directory, 'agent-model'))
    expect(payloads.has(encrypted.toString('hex'))).toBe(true)
    expect(encrypted.includes(Buffer.from(preset.apiKey))).toBe(false)
    expect(await connect()({ action: 'get' })).toEqual(publicPreset)
    expect(await connect()({ action: 'test' })).toEqual(publicPreset)
    expect(await connect()({ action: 'models', preset: { ...publicPreset, apiKey: '' } })).toEqual(['test-model'])
    expect(calls).toEqual([
      { url: '/v1/chat/completions', headers: 'Bearer synthetic-model-key', model: 'test-model' },
      { url: '/v1/models', headers: 'Bearer synthetic-model-key', model: undefined },
    ])
    await expect(request({ action: 'models', preset: { ...preset, baseUrl: `http://127.0.0.1:${address.port}/no-catalog/v1` } }))
      .rejects.toMatchObject({ code: 'model_list_unavailable', message: expect.stringContaining('HTTP 404') })
    await expect(request({ action: 'models', id: null, preset: {
      ...preset, provider: 'minimax', apiFormat: 'anthropic', baseUrl: 'https://api.minimaxi.cn/anthropic',
    } })).rejects.toMatchObject({ message: '接口地址无效' })
    await expect(request({ action: 'models', id: null, preset: {
      ...preset, provider: 'minimax', apiFormat: 'anthropic', baseUrl: 'https://api.minimax.cn/anthropic', apiKey: '',
    } })).rejects.toMatchObject({ message: '请填写此接口的 API Key' })
    const model = createDesktopAgentModelService(createDesktopAgentModelStore(directory, encryption))
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
    const sessionHandler = (host: CoreHost) => {
      host.setHostRequestHandler(async ({ method, params }) => {
        if (method === 'agent.files.present') {
          presentedFiles.push(JSON.stringify(params))
          return { opened: true, name: '合成预览', ext: 'png' }
        }
        if (method === 'agent.files.workspaceList') return [{
          id: 'desktop:33333333-3333-4333-8333-333333333333', name: '合成桌面工作区',
        }]
        if (method === 'agent.tools.policy') return desktopAgentToolPolicy()
        if (method === 'agent.memory.resolveEmbedding') return null
        const search = searches.find(item => method === `agent.search.${item.tool}`)
        if (search) {
          expect(params).toEqual({ operation_id: expect.any(String), ...search.args, ...search.hostDefaults })
          searchCalls.push(search.tool)
          return { kind: 'completed', successful: true, mutated: false, value: { summary: '合成研究结果' } }
        }
        expect(params).toEqual({})
        if (method === 'agent.search.similar_image_search.available') return true
        if (method === 'agent.search.deep_research.available') return true
        if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
        if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
        throw new Error('未预期的 Agent 宿主请求')
      })
      return agentSessionHandlers(host, model, undefined,
        createDesktopEmbeddingResolver(directory, encryption))[DESKTOP_CHANNELS.agentSessions]!
    }
    let send = sessionHandler(runtime)
    await runtime.request('projects.create', { name: '合成上下文项目' })
    const session = await send({ action: 'create', title: '合成会话', operationId: randomUUID() }) as { id: number }
    await expect(runtime.request('agent.sessions.workspace', { id: session.id, action: 'list' })).resolves.toEqual({
      workspaces: [{ id: 'desktop:33333333-3333-4333-8333-333333333333', name: '合成桌面工作区' }],
    })
    const operationId = randomUUID()
    try {
      await runtime.request('agent.sessions.setWorkspace', { id: session.id, action: 'bind',
        directoryId: 'desktop:33333333-3333-4333-8333-333333333333' })
    } catch (error) { throw new Error('桌面工作区绑定写入失败', { cause: error }) }
    await expect(runtime.request('agent.sessions.workspace', { id: session.id, action: 'show' })).resolves.toMatchObject({
      workspace: { workspace_id: 'desktop:33333333-3333-4333-8333-333333333333', workspace_name: '合成桌面工作区' },
    })
    const chunks: string[] = []
    let confirmedUserId: number | undefined
    const connection = new AbortController()
    const streaming = send({ action: 'send', stream: true, id: session.id, text: '合成流式请求', operationId }, (event: DesktopAgentChatEvent) => {
      if (event.type === 'content') chunks.push(event.text)
      if (event.type === 'session_id') confirmedUserId = event.user_message_id
    }, connection.signal)
    const detached = expect(streaming).rejects.toMatchObject({ code: 'closed' })
    await expect.poll(() => chunks.join('')).toBe('合成增量')
    expect(JSON.stringify(sentMessages)).toContain('合成上下文项目')
    const { runId } = await send({ action: 'events', id: session.id }) as { runId: string }
    expect(await send({ action: 'list' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: session.id, isRunning: true, workspaceName: '合成桌面工作区' }),
    ]))
    await expect(send({ action: 'history', id: session.id })).resolves.toMatchObject({ active: true })
    connection.abort()
    await detached
    chunks.length = 0
    const resumed = send({ action: 'resume', id: session.id, runId, operationId: randomUUID() }, (event: DesktopAgentChatEvent) => {
      if (event.type === 'content') chunks.push(event.text)
    })
    await expect.poll(() => chunks.join('')).toBe('合成增量')
    expect(await agentModelHandlers(model)[DESKTOP_CHANNELS.agentModel]!({ action: 'test' })).toEqual(publicPreset)
    openStream!.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    expect(confirmedUserId).toEqual(expect.any(Number))
    expect(await resumed).toMatchObject([{ id: confirmedUserId, role: 'user', text: '合成流式请求' }, {
      role: 'assistant', text: '合成增量',
      assistantTimeline: [expect.objectContaining({ kind: 'assistant', text: '合成增量', runId, anchorMessageId: String(confirmedUserId) })],
    }])
    expect(await send({ action: 'list' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: session.id, isRunning: false, lastAssistantId: expect.any(Number) }),
    ]))

    chunks.length = 0
    const cancelId = randomUUID()
    const cancelled = send({ action: 'send', stream: true, id: session.id, text: '合成取消请求', operationId: cancelId }, (event: DesktopAgentChatEvent) => {
      if (event.type === 'content') chunks.push(event.text)
    })
    const failed = expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
    await expect.poll(() => chunks.join('')).toBe('合成增量')
    expect(JSON.stringify(sentMessages)).toContain('合成流式请求')
    expect(JSON.stringify(sentMessages)).toContain('合成取消请求')
    await send({ action: 'cancel', id: session.id, operationId: cancelId })
    await failed
    const retrySession = await send({ action: 'create', title: '合成重试会话', operationId: randomUUID() }) as { id: number }
    const retryId = randomUUID()
    const retryEvents: DesktopAgentChatEvent[] = []
    const retry = send({ action: 'send', stream: true, id: retrySession.id, text: '合成模型繁忙',
      operationId: retryId }, (event: DesktopAgentChatEvent) => { retryEvents.push(event) })
    const stoppedRetry = expect(retry).rejects.toMatchObject({ code: 'cancelled' })
    try {
      await expect.poll(() => retryEvents.find(event => event.type === 'projected' && event.event.type === 'retry'))
        .toMatchObject({
        operationId: retryId,
        event: {
          type: 'retry', attempt: 1, max_retries: expect.any(Number), next_retry_in: expect.any(Number),
        },
      })
      expect(JSON.stringify(retryEvents)).not.toContain('synthetic-retry-detail')
    } finally {
      await send({ action: 'cancel', id: retrySession.id, operationId: retryId })
      await stoppedRetry
    }
    const interactionSession = await send({ action: 'create', title: '合成交互会话', operationId: randomUUID() }) as { id: number }
    const interactionModels = await model.put({ ...preset, apiKey: 'synthetic-interaction-key' }, null)
    const interactionModelId = interactionModels.items.find(item => item.id !== interactionModels.defaultId)!.id
    await send({ action: 'send', id: interactionSession.id, text: '合成交互问题', modelId: interactionModelId,
      operationId: randomUUID(), stream: true }, () => {})
    type InteractionPage = { runId: string; status: string; events: Array<{ type: string; prompt_id?: number; options?: Array<{ id: string; token: string }> }> }
    await runtime.close()
    runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
    send = sessionHandler(runtime)
    const page = await send({ action: 'events', id: interactionSession.id }) as InteractionPage
    expect(page.status).toBe('waiting')
    expect(await send({ action: 'list' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: interactionSession.id, isRunning: false }),
    ]))
    const { runId: interactionRun } = page
    const history = await send({ action: 'history', id: interactionSession.id }) as {
      messages: Array<{ interactions?: Array<{ id: number; run_id: string; resolved: boolean; options: Array<{ id: string; token: string }> }> }>
    }
    const prompt = history.messages.flatMap(message => message.interactions ?? []).find(item => item.run_id === interactionRun)
    expect(prompt).toMatchObject({ resolved: false })
    const choice = prompt?.options.find(option => option.id === 'a')
    expect(choice).toBeDefined()
    await expect(send({
      action: 'respond', id: interactionSession.id, runId: interactionRun, promptId: prompt!.id,
      token: choice!.token, operationId: randomUUID(),
    })).resolves.toEqual({ runId: interactionRun, awaitingText: false })
    await vi.waitFor(async () => {
      const result = await send({ action: 'events', id: interactionSession.id, runId: interactionRun }) as InteractionPage
      expect(result.status).toBe('completed')
    }, { timeout: 2500 })
    expect(await send({ action: 'messages', id: interactionSession.id })).toMatchObject([
      { role: 'user', text: '合成交互问题', interactions: [{
        run_id: interactionRun, title: '合成提示', resolved: true, selected_option_id: 'a', options: [],
      }] }, { role: 'assistant', text: '合成交互已续跑' },
    ])
    expect(await send({ action: 'history', id: interactionSession.id, before: 2 })).toMatchObject({
      messages: [{ role: 'user', interactions: [{ run_id: interactionRun, resolved: true, options: [] }] }],
    })
    expect(interactionKeys).toEqual(['Bearer synthetic-interaction-key', 'Bearer synthetic-interaction-key'])
    const textSession = await send({ action: 'create', title: '合成文本交互会话', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: textSession.id, text: '合成自由文本问题', operationId: randomUUID(), stream: true }, () => {})
    const textPage = await send({ action: 'events', id: textSession.id }) as InteractionPage
    expect(textPage.status).toBe('waiting')
    const textHistory = await send({ action: 'history', id: textSession.id }) as {
      messages: Array<{ interactions?: Array<{ id: number; run_id: string; options: Array<{ id: string; token: string }> }> }>
    }
    const textPrompt = textHistory.messages.flatMap(message => message.interactions ?? []).find(item => item.run_id === textPage.runId)
    const customReply = textPrompt?.options.find(option => option.id === '__custom_reply__')
    expect(customReply).toBeDefined()
    await expect(send({ action: 'respond', id: textSession.id, runId: textPage.runId, promptId: textPrompt!.id,
      token: customReply!.token, operationId: randomUUID() })).resolves.toEqual({ runId: textPage.runId, awaitingText: true })
    await expect(send({ action: 'respond', id: textSession.id, runId: textPage.runId, promptId: textPrompt!.id,
      text: ' 合成自由文本回答 ', operationId: randomUUID() })).resolves.toEqual({ runId: textPage.runId, awaitingText: false })
    await vi.waitFor(async () => {
      const result = await send({ action: 'events', id: textSession.id, runId: textPage.runId }) as InteractionPage
      expect(result.status).toBe('completed')
    }, { timeout: 2500 })
    expect(await send({ action: 'messages', id: textSession.id })).toMatchObject([
      { role: 'user', text: '合成自由文本问题', interactions: [{ run_id: textPage.runId, resolved: true, response_text: '合成自由文本回答' }] },
      { role: 'assistant', text: '合成交互已续跑' },
    ])
    await model.remove(interactionModelId)
    const cancelledInteraction = await send({ action: 'create', title: '合成取消交互', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: cancelledInteraction.id, text: '合成交互问题',
      operationId: randomUUID(), stream: true }, () => {})
    const pendingInteraction = await send({ action: 'events', id: cancelledInteraction.id }) as InteractionPage
    expect(pendingInteraction.status).toBe('waiting')
    await expect(send({ action: 'cancelRun', id: cancelledInteraction.id, runId: pendingInteraction.runId }))
      .resolves.toMatchObject({ outcome: 'requested' })
    expect(await send({ action: 'events', id: cancelledInteraction.id, runId: pendingInteraction.runId })).toMatchObject({
      status: 'cancelled',
      events: expect.arrayContaining([expect.objectContaining({ type: 'interaction_required', resolved: true, options: [] })]),
    })
    expect(await send({ action: 'events', id: cancelledInteraction.id })).toMatchObject({ status: 'idle', runId: null })
    const expiredInteraction = await send({ action: 'create', title: '合成过期交互', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: expiredInteraction.id, text: '合成交互问题',
      operationId: randomUUID(), stream: true }, () => {})
    const expiring = await send({ action: 'events', id: expiredInteraction.id }) as InteractionPage
    expect(expiring.status).toBe('waiting')
    await runtime.close()
    const database = new DatabaseSync(join(directory, 'chat.db'))
    try {
      database.prepare('UPDATE interaction_prompts SET expires_at=? WHERE session_id=?')
        .run('2000-01-01T00:00:00.000Z', expiredInteraction.id)
    } finally { database.close() }
    runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
    send = sessionHandler(runtime)
    expect(await send({ action: 'events', id: expiredInteraction.id, runId: expiring.runId })).toMatchObject({
      status: 'failed',
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'interaction_required', resolved: true, options: [] }),
        expect.objectContaining({ type: 'error', message: '这次交互已过期，请重新告诉我你的选择。' }),
      ]),
    })
    expect(await send({ action: 'events', id: expiredInteraction.id })).toMatchObject({ status: 'idle', runId: null })
    const savedInteraction = await send({ action: 'create', title: '合成回复恢复', operationId: randomUUID() }) as { id: number }
    await runtime.request('agent.sessions.append', { id: savedInteraction.id, text: '待摘要历史问题', reply: '合成待压缩回复' }, randomUUID())
    const summariesBeforeResume = summaryRequests
    await send({ action: 'send', id: savedInteraction.id, text: '合成交互问题压缩',
      operationId: randomUUID(), stream: true }, () => {})
    const waiting = await send({ action: 'events', id: savedInteraction.id }) as InteractionPage
    const savedPromptId = waiting.events.find(event => event.type === 'interaction_required')!.prompt_id!
    await runtime.close()
    const interrupted = new DatabaseSync(join(directory, 'chat.db'))
    try {
      const savedAnswer = JSON.stringify({ kind: 'choice', status: 'selected', prompt_id: savedPromptId,
        option_id: 'a', value: 'a', text: '合成选项' })
      interrupted.prepare("UPDATE interaction_prompts SET status='resolved',schema_json=json_set(schema_json,'$.resolved_result',json(?)) WHERE id=?")
        .run(savedAnswer, savedPromptId)
    } finally { interrupted.close() }
    runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
    send = sessionHandler(runtime)
    await expect(send({ action: 'respond', id: savedInteraction.id, runId: waiting.runId, promptId: savedPromptId, recover: true }))
      .resolves.toMatchObject({ runId: waiting.runId, awaitingText: false })
    await vi.waitFor(async () => {
      const result = await send({ action: 'events', id: savedInteraction.id, runId: waiting.runId }) as InteractionPage
      expect(result.status).toBe('completed')
    }, { timeout: 2500 })
    expect(summaryRequests).toBeGreaterThan(summariesBeforeResume)

    const toolsSession = await send({ action: 'create', title: '合成工具会话', operationId: randomUUID() }) as { id: number }
    const toolsMessages = await send({ action: 'send', id: toolsSession.id, text: '合成网页读取', operationId: randomUUID() })
    expect(toolsMessages).toMatchObject([{ role: 'user' }, { role: 'assistant', text: '合成工具执行完成',
      toolTimeline: [expect.objectContaining({ toolName: 'http_get' })] }])
    const toolCard = (toolsMessages as Array<{ toolTimeline?: Array<{
      detailsAvailable: boolean; detailSource: { messageId: number; index: number }
    }> }>)[1]!.toolTimeline![0]!
    expect(toolCard).toMatchObject({ detailsAvailable: true })
    expect(toolCard).not.toHaveProperty('toolResult')
    const { messageId, index } = toolCard.detailSource
    expect(JSON.stringify(await send({ action: 'toolDetails', id: toolsSession.id, messageId, index }))).toContain('公网访问校验')
    await expect(send({ action: 'toolDetails', id: session.id, messageId, index })).rejects.toMatchObject({ code: 'not_found' })
    expect(toolSchema).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'call_tool' }) })]))
    expect(JSON.stringify(toolResult)).toContain('input_rejected')
    expect(JSON.stringify(toolResult)).toContain('公网访问校验')
    const auxiliary = auxiliaryModelHandlers(directory, encryption)[DESKTOP_CHANNELS.auxiliaryModel]!
    await auxiliary({ action: 'create', input: { capability: 'embedding', provider: 'local', api_format: 'openai',
      base_url: preset.baseUrl, model: 'synthetic-embedding', value: '', dimensions: 3 } })
    const memorySession = await send({ action: 'create', title: '合成记忆会话', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: memorySession.id, text: '合成记忆写入', operationId: randomUUID() })
    await runtime.close()
    runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
    send = sessionHandler(runtime)
    const freshMemorySession = await send({ action: 'create', title: '合成新快照会话', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: freshMemorySession.id, text: '合成记忆读取', operationId: randomUUID() })
    expect(JSON.stringify(initialMemoryRequest)).toContain('合成用户偏好晨间阅读')
    const searchContent = memorySearchResult!.content
    expect(JSON.parse(typeof searchContent === 'string' ? searchContent : searchContent[0]!.text)).toMatchObject({
      strategy: 'hybrid', results: [expect.objectContaining({ text: expect.stringContaining('合成用户偏好晨间阅读') })],
    })
    await send({ action: 'send', id: memorySession.id, text: '合成记忆删除', operationId: randomUUID() })
    await runtime.close()
    runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
    send = sessionHandler(runtime)
    await send({ action: 'send', id: memorySession.id, text: '合成记忆读取', operationId: randomUUID() })
    const afterForget = memorySearchResult!.content
    expect(JSON.parse(typeof afterForget === 'string' ? afterForget : afterForget[0]!.text)).toMatchObject({ results: [] })
    const systemMessage = (initialMemoryRequest as Array<{ role: string; content: unknown }>)
      .find(message => message.role === 'system')
    expect(JSON.stringify(systemMessage)).not.toContain('合成用户偏好晨间阅读')
    const compactSession = await send({ action: 'create', title: '合成压缩会话', operationId: randomUUID() }) as { id: number }
    await runtime.request('agent.sessions.append', { id: compactSession.id, text: '待摘要历史问题', reply: '待摘要历史回复' }, randomUUID())
    const compactEvents: DesktopAgentChatEvent[] = []
    const summariesBeforeCompaction = summaryRequests
    await send({ action: 'send', id: compactSession.id, text: '合成压缩请求', operationId: randomUUID(), stream: true },
      (event: DesktopAgentChatEvent) => compactEvents.push(event))
    expect(compactEvents.filter(event => event.type === 'projected' && event.event.type === '_context_compaction')
      .map(event => event.type === 'projected' ? event.event.phase : undefined))
      .toEqual(expect.arrayContaining(['started', 'completed']))
    expect(summaryRequests).toBeGreaterThan(summariesBeforeCompaction)
    await send({ action: 'send', id: compactSession.id, text: '合成摘要续聊', operationId: randomUUID() })
    const continued = JSON.stringify(sentMessageHistory.findLast(messages => JSON.stringify(messages).includes('合成摘要续聊')))
    expect(continued).toContain('合成会话摘要')
    expect(continued).toContain('合成压缩请求')
    expect(continued).not.toContain('待摘要历史问题')
    expect(await send({ action: 'messages', id: compactSession.id })).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: '待摘要历史问题' })]),
    )
    conversationId = compactSession.id
    const searchSession = await send({ action: 'create', title: '合成历史工具会话', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: searchSession.id, text: '合成历史关键词检索', operationId: randomUUID() })
    const readSession = await send({ action: 'create', title: '合成正文工具会话', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: readSession.id, text: '合成历史正文读取', operationId: randomUUID() })
    await runtime.request('clients.create', { name: '合成联系人小北' })
    await send({ action: 'send', id: readSession.id, text: '合成联系人查询', operationId: randomUUID() })
    expect(conversationResults).toHaveLength(3)
    expect(JSON.stringify(conversationResults[2])).toContain('合成联系人小北')
    expect(JSON.stringify(conversationResults[0])).toContain('合成压缩会话')
    expect(JSON.stringify(conversationResults[1])).toContain('待摘要历史回复')
    await send({ action: 'send', id: searchSession.id, text: '合成画布引用检索', operationId: randomUUID() })
    const placeables = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof placeables === 'string' ? placeables : placeables[0]!.text)).toMatchObject({
      matches: [{ title: '合成上下文项目', ref_type: 'project', already_placed: false }],
    })

    await runtime.request('schedules.create', { fields: {
      name: '合成独立提醒', schedule_kind: 'once', start_at: new Date(Date.now() + 60_000).toISOString(),
    } })
    await send({ action: 'send', id: searchSession.id, text: '合成定时任务查询', operationId: randomUUID() })
    const tasks = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof tasks === 'string' ? tasks : tasks[0]!.text)).toMatchObject([
      { name: '合成独立提醒', schedule_kind: 'once', filesystem_authorized: false },
    ])

    const attachmentId = randomBytes(16).toString('hex')
    await runtime.request('agent.attachments.stage', { attachment: { attachId: attachmentId,
      name: '合成图片.png', ext: 'png', mime: 'image/png', size: 12, voice: false } })
    await send({ action: 'send', id: searchSession.id, text: '合成近期附件查询', operationId: randomUUID() })
    const recentResult = conversationResults.at(-1) as string | Array<{ text: string }>
    const recent = JSON.parse(typeof recentResult === 'string' ? recentResult : recentResult[0]!.text)
    expect(recent).toMatchObject({ count: 1, items: [{ attach_id: attachmentId, name: '合成图片.png', state: 'draft' }] })
    expect(JSON.stringify(recent)).not.toContain('agent-attachments/')

    await send({ action: 'send', id: searchSession.id, text: '合成文件预览', operationId: randomUUID() })
    expect(presentedFiles).toEqual([JSON.stringify({ path: '/personal/合成预览.png' })])
    const presented = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof presented === 'string' ? presented : presented[0]!.text)).toMatchObject({
      ok: true, message: '已在桌面预览窗口打开《合成预览.png》。', name: '合成预览', ext: 'png',
    })

    const createdSkill = await runtime.request<{ id: string }>('skills.create', { fields: {
      name: '合成用户技能', description_short: '合成技能摘要', body: '合成技能正文',
    } })
    skillId = createdSkill.id
    await send({ action: 'send', id: searchSession.id, text: '合成用户技能读取', operationId: randomUUID() })
    const loadedSkill = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof loadedSkill === 'string' ? loadedSkill : loadedSkill[0]!.text)).toMatchObject({
      skill_id: skillId, skill_name: '合成用户技能', content: '合成技能正文',
    })

    await send({ action: 'send', id: searchSession.id, text: '合成内置技能读取', operationId: randomUUID() })
    const builtinSkill = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof builtinSkill === 'string' ? builtinSkill : builtinSkill[0]!.text)).toMatchObject({
      skill_id: 'S2', skill_name: '图表与数学表达', content: expect.stringContaining('Mermaid'),
    })

    await send({ action: 'send', id: searchSession.id, text: '合成通用工具调用', operationId: randomUUID() })
    const forwardedTool = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(typeof forwardedTool === 'string' ? forwardedTool : forwardedTool[0]!.text)
      .toContain('timezone')

    await send({ action: 'send', id: searchSession.id, text: '合成未开放工具调用', operationId: randomUUID() })
    expect(JSON.stringify(conversationResults.at(-1))).toContain('工具不存在或未开放')

    await send({ action: 'send', id: searchSession.id, text: '合成笔记创建', operationId: randomUUID() })
    expect(JSON.stringify(await runtime.request('mind.notes.list', {}))).toContain('合成笔记正文')

    await send({ action: 'send', id: searchSession.id, text: '合成画布写入', operationId: randomUUID() })
    const canvases = await runtime.request<Array<{ id: number; title: string }>>('mind.canvases.list', {})
    canvasId = canvases.find(canvas => canvas.title === '合成 Agent 画布')?.id ?? 0
    expect(canvasId).toBeGreaterThan(0)
    await send({ action: 'send', id: searchSession.id, text: '合成画布写入便签', operationId: randomUUID() })
    expect(JSON.stringify(await runtime.request('mind.canvases.items.list', { canvasId }))).toContain('合成画布便签正文')

    await send({ action: 'send', id: searchSession.id, text: '合成活动创建', operationId: randomUUID() })
    const activity = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof activity === 'string' ? activity : activity[0]!.text)).toMatchObject({
      title: '合成 Agent 日历活动', date: '2099-09-10', reminders: [{ lead_minutes: 10, channels: ['web'], enabled: true }],
    })

    await send({ action: 'send', id: searchSession.id, text: '合成项目创建', operationId: randomUUID() })
    expect(await runtime.request('projects.list', {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '合成 Agent 项目' }),
    ]))

    await send({ action: 'send', id: searchSession.id, text: '合成技能创建', operationId: randomUUID() })
    const skillCreation = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof skillCreation === 'string' ? skillCreation : skillCreation[0]!.text)).toMatchObject({
      success: true, skill: { name: '合成 Agent 技能', related_tools: ['get_current_time'] },
    })

    await send({ action: 'send', id: searchSession.id, text: '合成提醒创建', operationId: randomUUID() })
    const reminder = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof reminder === 'string' ? reminder : reminder[0]!.text)).toMatchObject({
      success: true, name: '合成 Agent 提醒', execution_mode: 'reminder', channels: ['web'],
    })

    await send({ action: 'send', id: searchSession.id, text: '合成提醒更新', operationId: randomUUID() })
    const reminderUpdate = conversationResults.at(-1) as string | Array<{ text: string }>
    expect(JSON.parse(typeof reminderUpdate === 'string' ? reminderUpdate : reminderUpdate[0]!.text)).toMatchObject({
      success: true, name: '合成 Agent 提醒', execution_mode: 'reminder',
    })
    expect(await runtime.request('schedules.list', {})).toMatchObject({
      tasks: expect.arrayContaining([expect.objectContaining({
        name: '合成 Agent 提醒', payload: '  合成更新后的提醒正文\n', execution_mode: 'reminder',
      })]),
    })

    const deletionSession = await send({ action: 'create', title: '合成删除会话', operationId: randomUUID() }) as { id: number }
    expect(await send({ action: 'send', id: deletionSession.id, text: '合成提醒不可交互删除', operationId: randomUUID() }))
      .toMatchObject([{ role: 'user' }, { role: 'assistant', text: '未开放删除工具' }])
    for (const scenario of ['cancel', 'stale', 'confirm']) {
      const optionId = scenario === 'cancel' ? 'cancel' : 'confirm'
      await send({ action: 'send', stream: true, id: deletionSession.id, text: '合成提醒删除',
        operationId: randomUUID() }, () => {})
      if (scenario === 'confirm') {
        await runtime.close()
        runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
        send = sessionHandler(runtime)
      }
      const page = await send({ action: 'events', id: deletionSession.id }) as InteractionPage
      expect(page.status).toBe('waiting')
      const prompt = page.events.find(event => event.type === 'interaction_required')
      expect(prompt).toMatchObject({ body: '将删除定时任务：合成 Agent 提醒，共 1 个' })
      const option = prompt?.options?.find(option => option.id === optionId)
      expect(option).toBeDefined()
      expect(await runtime.request('schedules.list', {})).toMatchObject({
        tasks: expect.arrayContaining([expect.objectContaining({ name: '合成 Agent 提醒' })]),
      })
      if (scenario === 'stale') {
        const { tasks } = await runtime.request('schedules.list', {}) as { tasks: Array<{ id: number; name: string }> }
        const target = tasks.find(task => task.name === '合成 Agent 提醒')!
        await runtime.request('schedules.update', { id: target.id, fields: { payload: '确认后变更的提醒' } })
      }
      await send({ action: 'respond', id: deletionSession.id, runId: page.runId, promptId: prompt!.prompt_id,
        token: option!.token, operationId: randomUUID() })
      await vi.waitFor(async () => {
        expect(await send({ action: 'events', id: deletionSession.id, runId: page.runId })).toMatchObject({ status: 'completed' })
      })
      if (scenario === 'stale') {
        expect(await runtime.request('schedules.list', {})).toMatchObject({
          tasks: expect.arrayContaining([expect.objectContaining({
            name: '合成 Agent 提醒', payload: '确认后变更的提醒',
          })]),
        })
      }
    }
    const deletedSchedules = await runtime.request('schedules.list', {}) as { tasks: Array<{ name: string }> }
    expect(deletedSchedules.tasks.map(task => task.name)).not.toContain('合成 Agent 提醒')

    const longSession = await send({ action: 'create', title: '合成长回复会话', operationId: randomUUID() }) as { id: number }
    const longChunks: string[] = []
    await send({ action: 'send', stream: true, id: longSession.id, text: '合成长回复', operationId: randomUUID() }, (event: DesktopAgentChatEvent) => {
      if (event.type === 'content') longChunks.push(event.text)
    })
    expect(longChunks.join('')).toBe(longReply)
    const longHistory = await send({ action: 'history', id: longSession.id }) as { messages: Array<{ text: string }> }
    expect(longHistory.messages.at(-1)?.text).toBe(longReply)
    expect(embeddingInputs).toEqual(expect.arrayContaining(['合成用户偏好晨间阅读', '晨间阅读']))
    await expect(request({ action: 'models', preset: { ...publicPreset, baseUrl: 'https://example.test/v1', apiKey: '' } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(request({ action: 'save', preset: { ...preset, provider: 'local', apiFormat: 'native' } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(request({ action: 'save', preset: { ...preset, baseUrl: 'http://example.test/v1' } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    await expect(request({ action: 'save', preset: { ...preset, baseUrl: 'https://example.test/v1?token=synthetic' } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(await request({ action: 'get' })).toEqual(publicPreset)
    const options = { contextTokens: 32000, maxTokens: 1024, thinkingMode: 'default', image: true }
    const configured = { ...publicPreset, ...options }
    expect(await request({ action: 'capabilities', model: { ...publicPreset, baseUrl: '', localRuntime: 'llama.cpp' } }))
      .toMatchObject({ default_base_url: 'http://127.0.0.1:8080/v1' })
    expect(await request({ action: 'save', preset: { ...configured, apiKey: preset.apiKey } })).toEqual(configured)
    expect(await connect()({ action: 'get' })).toEqual(configured)
    expect(await request({ action: 'probe', dim: 'image', preset: { ...configured, apiKey: '' } }))
      .toMatchObject({ supported: true, dim: 'image' })
    expect(await request({ action: 'probe', dim: 'audio', preset: { ...configured, apiKey: '' } }))
      .toMatchObject({ supported: true, dim: 'audio' })
    expect(await request({ action: 'probe', dim: 'video', preset: { ...configured, apiKey: '' } }))
      .toMatchObject({ supported: false, dim: 'video' })
    expect(await connect()({ action: 'get' })).toEqual(configured)
    for (const search of searches) {
      const searchSession = await send({ action: 'create', title: '合成搜索会话', operationId: randomUUID() }) as { id: number }
      await expect(send({ action: 'send', id: searchSession.id, text: search.prompt, operationId: randomUUID() }))
        .resolves.toMatchObject([{ role: 'user' }, { role: 'assistant', text: '已取得研究结果',
          toolTimeline: [expect.objectContaining({ toolName: search.tool })] }])
    }
    expect(searchCalls).toEqual(searches.map(search => search.tool))
    for (const [prompt, tool] of [
      ['合成知识写入', 'save_knowledge'], ['合成知识更新', 'update_knowledge'], ['合成知识读取', 'read_knowledge'],
    ]) {
      const knowledgeSession = await send({ action: 'create', title: '合成知识会话', operationId: randomUUID() }) as { id: number }
      await expect(send({ action: 'send', id: knowledgeSession.id, text: prompt, operationId: randomUUID() }))
        .resolves.toMatchObject([{ role: 'user' }, { role: 'assistant', text: '合成知识操作完成',
          toolTimeline: [expect.objectContaining({ toolName: tool, toolStatus: 'success' })] }])
    }
    const deleteKnowledgeSession = await send({ action: 'create', title: '合成知识删除会话', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id: deleteKnowledgeSession.id, text: '合成知识删除', operationId: randomUUID(), stream: true }, () => {})
    const deleteKnowledgePage = await send({ action: 'events', id: deleteKnowledgeSession.id }) as InteractionPage
    expect(deleteKnowledgePage.status).toBe('waiting')
    const deleteKnowledgePrompt = deleteKnowledgePage.events.find(event => event.type === 'interaction_required')!
    expect(deleteKnowledgePrompt).toMatchObject({ body: '将删除知识条目「合成知识标题」，保留历史但停止检索' })
    const confirmKnowledge = deleteKnowledgePrompt.options?.find(option => option.id === 'confirm')!
    await send({ action: 'respond', id: deleteKnowledgeSession.id, runId: deleteKnowledgePage.runId,
      promptId: deleteKnowledgePrompt.prompt_id, token: confirmKnowledge.token, operationId: randomUUID() })
    await expect.poll(async () => send({ action: 'messages', id: deleteKnowledgeSession.id })).toMatchObject([
      { role: 'user' }, { role: 'assistant', text: '合成知识操作完成',
        toolTimeline: [expect.objectContaining({ toolName: 'delete_knowledge', toolStatus: 'success' })] },
    ])
    const listMcp = async () => (await runtime!.request<{ items: Array<{ id: string; name: string; tool_allowlist: string[] }> }>('mcp.list')).items
    for (const [text, summary] of [
      ['合成新增测试服务', '将添加 MCP 服务「synthetic-mcp」（https://mcp.example.test），停用，每次调用均需确认。确认后通过私密表单填写 Header 凭据'],
      ['合成新增测试服务并取消凭据', '将添加 MCP 服务「synthetic-cancel」（https://mcp.example.test），停用，每次调用均需确认。确认后通过私密表单填写 Header 凭据'],
      ['合成修改测试服务', '将更新 MCP 服务「synthetic-mcp」的调整工具白名单'],
    ]) {
      const id = (await send({ action: 'create', title: '合成服务配置会话', operationId: randomUUID() }) as { id: number }).id
      const before = await listMcp()
      await send({ action: 'send', id, text, operationId: randomUUID(), stream: true }, () => {})
      const page = await send({ action: 'events', id }) as InteractionPage
      expect(page.status).toBe('waiting')
      const prompt = page.events.find(event => event.type === 'interaction_required')!
      expect(prompt).toMatchObject({ body: summary })
      expect(await listMcp()).toEqual(before)
      await send({ action: 'respond', id, runId: page.runId, promptId: prompt.prompt_id,
        token: prompt.options!.find(option => option.id === 'confirm')!.token, operationId: randomUUID() })
      const cancelSecrets = text.includes('取消凭据')
      const serverName = cancelSecrets ? 'synthetic-cancel' : 'synthetic-mcp'
      if (text.includes('新增')) {
        let form: InteractionPage['events'][number] | undefined
        await expect.poll(async () => {
          const events = await send({ action: 'events', id, runId: page.runId }) as InteractionPage
          form = events.events.find(event => event.type === 'interaction_required' && event.prompt_id !== prompt.prompt_id)
          return form
        }).toMatchObject({ secret_fields: [{ name: 'key', label: '合成凭据', type: 'secret' }] })
        await runtime!.close()
        runtime = await launchCoreHost(process.execPath, entry, join(directory, 'chat.db'))
        send = sessionHandler(runtime)
        const recovered = await send({ action: 'events', id, runId: page.runId }) as InteractionPage
        expect(recovered.status).toBe('waiting')
        expect(recovered.events).toContainEqual(expect.objectContaining({ prompt_id: form!.prompt_id,
          secret_fields: [{ name: 'key', label: '合成凭据', type: 'secret' }] }))
        await send({ action: 'respond', id, runId: page.runId, promptId: form!.prompt_id,
          secrets: cancelSecrets ? null : { key: 'synthetic-mcp-secret' }, operationId: randomUUID() })
        const server = (await listMcp()).find(item => item.name === serverName)!
        const config = await runtime!.request<{ credential_values: Record<string, string> }>('mcp.config', { id: server.id })
        expect(config.credential_values).toEqual(cancelSecrets ? {} : { key: 'synthetic-mcp-secret' })
      }
      await expect.poll(async () => (await send({ action: 'events', id, runId: page.runId }) as InteractionPage).status).toBe(cancelSecrets ? 'cancelled' : 'completed')
      expect(JSON.stringify(await send({ action: 'history', id })).includes('synthetic-mcp-secret')).toBe(false)
      expect(JSON.stringify(sentMessageHistory).includes('synthetic-mcp-secret')).toBe(false)
      expect(await listMcp()).toEqual(expect.arrayContaining([expect.objectContaining({
        name: serverName, tool_allowlist: text.includes('修改') ? ['lookup'] : [],
      })]))
    }
    const savedMcp = (await listMcp()).find(item => item.name === 'synthetic-mcp')!
    for (const decision of ['cancel', 'confirm']) {
      const mcpSession = await send({ action: 'create', title: '合成服务删除会话', operationId: randomUUID() }) as { id: number }
      await send({ action: 'send', id: mcpSession.id, text: '合成删除测试服务', operationId: randomUUID(), stream: true }, () => {})
      const page = await send({ action: 'events', id: mcpSession.id }) as InteractionPage
      expect(page.status).toBe('waiting')
      const prompt = page.events.find(event => event.type === 'interaction_required')!
      expect(prompt).toMatchObject({ body: '删除 MCP server [synthetic-mcp]' })
      const hasServer = async () => (await runtime!.request<{ items: Array<{ id: string }> }>('mcp.list')).items
        .some(item => item.id === savedMcp.id)
      expect(await hasServer()).toBe(true)
      await send({ action: 'respond', id: mcpSession.id, runId: page.runId, promptId: prompt.prompt_id,
        token: prompt.options!.find(option => option.id === decision)!.token, operationId: randomUUID() })
      await expect.poll(async () => (await send({ action: 'events', id: mcpSession.id, runId: page.runId }) as InteractionPage).status).toBe('completed')
      expect(await hasServer()).toBe(decision === 'cancel')
    }
    const goalSession = await send({ action: 'create', title: '合成目标会话', operationId: randomUUID() }) as { id: number }
    const goalMessages = await send({ action: 'send', id: goalSession.id, text: '/goal 合成目标验收', operationId: randomUUID() })
    expect(goalRounds).toBe(2)
    expect(goalMessages).toMatchObject([{ role: 'user', text: '/goal 合成目标验收' }, { role: 'assistant' }])
    expect(JSON.stringify(goalMessages).includes('GUGU_GOAL_DONE')).toBe(false)
    for (const decision of ['pause', 'cancel'] as const) {
      const interruptedSession = await send({ action: 'create', title: '合成中断目标', operationId: randomUUID() }) as { id: number }
      const previousStream = openStream
      const pending = send({ action: 'send', id: interruptedSession.id, stream: true, text: '/goal 合成目标中断验收',
        operationId: randomUUID() }, () => {})
      const outcome = pending.then(() => null, error => error)
      await expect.poll(() => openStream !== previousStream, { timeout: 5000 }).toBe(true)
      await send({ action: 'goal', id: interruptedSession.id, goalAction: decision })
      expect(await outcome).toMatchObject({ code: 'cancelled' })
      expect(await send({ action: 'history', id: interruptedSession.id })).toMatchObject({
        active: false, session: { goalActive: false, goalStatus: decision === 'pause' ? 'paused' : null },
      })
    }
    const deniedModel = { ...configured, model: 'denied-model' }
    expect(await request({ action: 'save', preset: { ...deniedModel, apiKey: '' } })).toEqual(deniedModel)
    await expect(connect()({ action: 'test' })).rejects.toMatchObject({
      code: 'model_unavailable', message: '模型认证失败（HTTP 401）',
    })
    const deniedSession = await send({ action: 'create', title: '合成认证失败会话', operationId: randomUUID() }) as { id: number }
    await expect(send({ action: 'send', id: deniedSession.id, text: '合成认证失败请求', operationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'model_unavailable', message: '模型认证失败（HTTP 401）' })
    expect(await send({ action: 'messages', id: deniedSession.id })).toMatchObject([
      { role: 'user', text: '合成认证失败请求', runOutcome: { status: 'failed' } },
    ])
    expect(calls.at(-1)).toEqual({
      url: '/v1/chat/completions', headers: 'Bearer synthetic-model-key', model: 'denied-model',
    })
    await expect(request({ action: 'save', preset: { ...deniedModel, baseUrl: 'https://example.test/v1', apiKey: '' } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    expect(await request({ action: 'get' })).toEqual(deniedModel)

    // 直接写入旧版单模型密文，验证真实升级路径。
    const legacyCiphertext = await encryption.encryptStringAsync(JSON.stringify({ ...deniedModel, apiKey: preset.apiKey }))
    await writeFile(join(directory, 'agent-model'), legacyCiphertext)
    const service = createDesktopAgentModelService(createDesktopAgentModelStore(directory, encryption))
    const commands = agentModelHandlers(service)[DESKTOP_CHANNELS.agentModel]!
    const original = await service.list()
    const legacyId = original.items[0]!.id
    expect(original).toEqual({ items: [{ ...deniedModel, id: legacyId }], defaultId: legacyId })

    const second = { ...publicPreset, model: 'second-model', apiKey: 'synthetic-second-key' }
    const third = { ...publicPreset, model: 'third-model', apiKey: '' }
    await Promise.all([
      commands({ action: 'put', id: null, preset: second }),
      commands({ action: 'put', id: null, preset: third }),
    ])
    const afterAdd = await service.list()
    const [, secondEntry, thirdEntry] = afterAdd.items
    expect(afterAdd.items.map(item => item.model)).toEqual(['denied-model', 'second-model', 'third-model'])
    expect(afterAdd.defaultId).toBe(legacyId)
    expect(JSON.stringify(afterAdd)).not.toContain('synthetic-')
    const backups = (await readdir(directory)).filter(file => file.endsWith('.bak'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(directory, backups[0]!))).toEqual(legacyCiphertext)

    await commands({ action: 'put', id: secondEntry!.id, preset: { ...second, model: 'renamed-model', apiKey: '' } })
    await commands({ action: 'test', id: secondEntry!.id })
    expect(calls.at(-1)).toMatchObject({ model: 'renamed-model', headers: 'Bearer synthetic-second-key' })
    await commands({ action: 'test', id: secondEntry!.id, preset: { ...second, model: 'draft-model', apiKey: '' } })
    expect(calls.at(-1)).toMatchObject({ model: 'draft-model', headers: 'Bearer synthetic-second-key' })
    expect((await service.list()).items.find(item => item.id === secondEntry!.id)?.model).toBe('renamed-model')
    await commands({ action: 'test', id: thirdEntry!.id })
    expect(calls.at(-1)).toMatchObject({ model: 'third-model', headers: 'Bearer dummy' })
    await expect(commands({ action: 'put', id: null, preset: { ...second, provider: 'openai', baseUrl: 'https://example.test/v1', apiKey: '' } }))
      .rejects.toMatchObject({ code: 'invalid_request' })
    const reopened = createDesktopAgentModelService(createDesktopAgentModelStore(directory, encryption))
    const selectSession = await send({ action: 'create', title: '合成选模会话', operationId: randomUUID() }) as { id: number }
    await expect(send({ action: 'send', id: selectSession.id, text: '测试聊天选模',
      operationId: randomUUID(), modelId: secondEntry!.id })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ text: 'OK' })]))
    expect(calls.at(-1)).toMatchObject({ model: 'renamed-model', headers: 'Bearer synthetic-second-key' })
    await commands({ action: 'set_default', id: secondEntry!.id })
    await expect(send({ action: 'send', id: selectSession.id, text: '测试聊天默认模型',
      operationId: randomUUID() })).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ text: 'OK' })]))
    expect(calls.at(-1)).toMatchObject({ model: 'renamed-model', headers: 'Bearer synthetic-second-key' })
    await commands({ action: 'delete', id: secondEntry!.id })
    expect((await service.list()).defaultId).toBe(legacyId)
    await expect(commands({ action: 'test', id: secondEntry!.id })).rejects.toMatchObject({ code: 'invalid_request' })
    await commands({ action: 'delete', id: legacyId })
    expect((await service.list()).defaultId).toBe(thirdEntry!.id)
    await commands({ action: 'delete', id: thirdEntry!.id })
    expect(await connect()({ action: 'list' })).toEqual({ items: [], defaultId: null })
    const miniMax = { provider: 'minimax', apiFormat: 'anthropic', model: 'MiniMax-M3.1-Flash',
      baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'synthetic-minimax-key' }
    const configuredMiniMax = await service.put({ ...miniMax, webSearchEnabled: true }, null)
    const miniMaxId = configuredMiniMax.defaultId!
    expect((await reopened.get())?.webSearchEnabled).toBe(true)
    expect(await reopened.resolveRunModelSelection(miniMaxId)).toMatchObject({
      id: miniMaxId, config: { provider: 'minimax', base_url: miniMax.baseUrl, web_search_enabled: true },
    })
    await expect(service.put({ ...miniMax, baseUrl: 'https://proxy.example.test/anthropic', webSearchEnabled: true }, miniMaxId))
      .rejects.toMatchObject({ code: 'invalid_request', message: expect.stringContaining('联网搜索') })
    expect(await reopened.get()).toMatchObject({ baseUrl: miniMax.baseUrl, webSearchEnabled: true })
    const migrated = await service.put({ ...miniMax, baseUrl: 'https://api.minimax.cn/anthropic', apiKey: '', webSearchEnabled: false }, miniMaxId)
    expect((await reopened.get())?.webSearchEnabled).toBe(false)
    expect(await reopened.resolveRunModelSelection(miniMaxId)).toMatchObject({
      id: miniMaxId, config: { web_search_enabled: false },
    })
    expect(migrated.items[0]?.baseUrl).toBe('https://api.minimax.cn/anthropic')
    await expect(service.models({ ...miniMax, baseUrl: 'https://api.minimax.cn/anthropic', apiKey: '' }, miniMaxId))
      .resolves.toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3'])
    expect(JSON.stringify(migrated)).not.toContain(miniMax.apiKey)
    for (const baseUrl of ['https://api.minimax.cn.example.test/anthropic', 'https://api.minimax.cn:8443/anthropic']) {
      await expect(service.put({ ...miniMax, baseUrl, apiKey: '' }, miniMaxId)).rejects.toMatchObject({ code: 'invalid_request' })
    }
  } finally {
    await runtime?.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
