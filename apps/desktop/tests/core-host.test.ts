import { createDroppedFileReferences } from '../src/main/files/dropped-references.js'
import { resourceHandlers } from '../src/main/mcp/ipc.js'
import { registerDesktopIpc } from '../src/main/ipc/register.js'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { workspaceHandlers } from '../src/main/workspace/ipc.js'
import { desktopFiles } from '../src/main/files/ipc.js'
import { canvasHandlers } from '../src/main/workspace/canvas.js'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createServer, request, type Server } from 'node:http'
import { LocalRuntime } from '@gugu/core/local'
import { CORE_SCHEMA_VERSION, DESKTOP_CHANNELS, type DesktopAgentChatEvent, type DesktopAgentEventPage } from '@gugu/core/desktop'
import { serializeAgentKnowledgeEntry } from '@gugu/core/agent/knowledge/entry'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  CoreHost,
  DesktopError,
  verifyArtifact,
  desktopReply,
} from '../src/main/core-host.js'
import { startDesktopPreviewAgent } from '../src/main/preview-agent.js'
import { agentSessionHandlers } from '../src/main/agent/ipc.js'
import type { createDesktopAgentModelService } from '../src/main/agent/model.js'
import { desktopAgentAttachmentHandlers } from '../src/main/agent/attachments.js'
import { DesktopLifecycle } from '../src/main/lifecycle.js'
import { desktopAgentToolPolicy } from '../src/main/agent/tool-policy.js'

const desktopAgentRuntimeModule = fileURLToPath(new URL('../.tools/agent/runtime.mjs', import.meta.url))
const folders: string[] = []
function launchCoreHost(node: string, entry: string, database: string, manifest?: Parameters<typeof CoreHost.launch>[3],
  timeoutMs?: number, memoryRoot?: string, workerEntry?: string) {
  return CoreHost.launch(node, entry, database, manifest, timeoutMs, memoryRoot, workerEntry, desktopAgentRuntimeModule)
}
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'gugu-electron-host-'))
  folders.push(path)
  return path
}
afterEach(() => {
  for (const path of folders.splice(0))
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })
})
function fake(response: string, undoAvailable = true) {
  const root = directory(),
    entry = join(root, 'host.mjs')
  writeFileSync(
    entry,
    `import {createInterface} from 'node:readline'; process.stdout.write(JSON.stringify({v:2,event:'ready',schema:'${CORE_SCHEMA_VERSION}',capabilities:${JSON.stringify(undoAvailable ? ['operation_receipts', 'undo_mind_v1'] : ['operation_receipts'])}})+'\\n'); createInterface({input:process.stdin}).on('line',line=>{ const request=JSON.parse(line); const response=request.method==='operations.get'?{v:2,id:request.id,result:null}:${response}; process.stdout.write(JSON.stringify(response)+'\\n') });`,
  )
  return launchCoreHost(process.execPath, entry, join(root, 'core.db'))
}
function requestPreviewAttachment(socketPath: string, secret: string, payload: Buffer | string, headers: Record<string, string>) {
  return new Promise<unknown>((resolve, reject) => {
    const req = request({ socketPath, path: '/__desktop-preview/agent-attachments', method: 'POST',
      headers: { Authorization: secret, ...headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

describe('Electron 与独立 Node Core 的真实边界', () => {
  it('聊天事件读取超时后保留同一个 Worker，并忽略迟到的结果', async () => {
    const root = directory()
    const worker = join(root, 'slow-worker.mjs')
    writeFileSync(worker, `
      import { parentPort } from 'node:worker_threads'
      let calls = 0
      parentPort.on('message', ({ id, method }) => {
        if (method === 'runtime.close') {
          parentPort.postMessage({ id, result: null })
          parentPort.close()
          return
        }
        const result = ++calls
        setTimeout(() => parentPort.postMessage({ id, result }), result === 1 ? 1100 : 150)
      })
      parentPort.postMessage({ event: 'ready', ownerId: 'fixture', schemaVersion: ${JSON.stringify(String(CORE_SCHEMA_VERSION))} })
    `)
    const exited = vi.fn()
    const runtime = await LocalRuntime.open(join(root, 'core.db'), { workerEntry: worker, onWorkerExit: exited })
    try {
      await expect(runtime.call('agent.sessions.events', {}, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'busy' })
      await expect(runtime.call('agent.sessions.events')).resolves.toBe(2)
      expect(exited).not.toHaveBeenCalled()
    } finally { await runtime.close() }
  })
  it('数据 Worker 异常退出时报告安全分类，并结束正在等待的聊天事件读取', async () => {
    const root = directory()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const worker = join(root, 'worker.mjs')
    writeFileSync(worker, `
      import { parentPort } from 'node:worker_threads'
      parentPort.once('message', () => { throw new Error('合成私有异常') })
      parentPort.postMessage({ event: 'ready', ownerId: 'fixture', schemaVersion: ${JSON.stringify(String(CORE_SCHEMA_VERSION))} })
    `)
    const report = vi.fn()
    const host = await CoreHost.launch(process.execPath, entry, join(root, 'core.db'),
      undefined, undefined, undefined, worker, undefined, report)
    try {
      await expect(host.request('agent.sessions.events', { id: 1, after: 0 })).rejects.toMatchObject({ code: 'closed' })
      await expect.poll(() => report.mock.calls).toEqual([
        ['host.core_worker_exit', { exitCode: 1, code: 'uncaught_exception',
          frames: expect.arrayContaining([expect.stringMatching(/^worker\.mjs:\d+:\d+$/)]) }],
      ])
      await expect(host.request('agent.sessions.events', { id: 1, after: 0 })).rejects.toMatchObject({ code: 'closed' })
    } finally { await host.close() }
  })
  it('本机和工作区文件引用作为画布文件卡持久化，拒绝失效引用', async () => {
    const root = directory()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, join(root, 'core.db'))
    try {
      const files = desktopFiles(join(root, '工作区'))
      const personal = await files.personalRoot()
      writeFileSync(join(personal, '工作区样本.txt'), '合成文件')
      const ref = await files.handlers[DESKTOP_CHANNELS.files]!({ action: 'reference', directoryId: 'personal', path: '工作区样本.txt' }) as { id: string }
      const dropped = createDroppedFileReferences(root, async () => '')
      const localPath = join(root, '本机样本.txt')
      writeFileSync(localPath, '合成文件')
      const authorizedPath = realpathSync(localPath)
      const info = lstatSync(authorizedPath, { bigint: true })
      const identity = [info.dev, info.ino, info.birthtimeNs].join('.')
      await expect(dropped.create(authorizedPath, '0.0.0')).rejects.toMatchObject({ code: 'not_found' })
      const localRef = await dropped.create(authorizedPath, identity)
      expect(JSON.stringify(localRef)).not.toContain(authorizedPath)
      const canvas = await host.request<{ id: number }>('mind.canvases.create', { title: '合成画布' })
      const add = canvasHandlers(host, async id => {
        const file = id.startsWith('drop-') ? await dropped.resolve(id) : await files.resolveWorkspaceReference(id)
        return file?.path.split('/').at(-1) ?? null
      })[DESKTOP_CHANNELS.addCanvasItem]!
      for (const [id, title] of [[ref.id, '工作区样本.txt'], [localRef.id, '本机样本.txt']]) {
        await expect(add(canvas.id, { fileRefId: id, x: 12, y: 24 })).resolves.toMatchObject({
          x: 12, y: 24, node: { title, refType: 'file', refSnapshot: { fileReferenceId: id } },
        })
      }
      await expect(add(canvas.id, { fileRefId: 'drop-synthetic', x: 1 })).rejects.toMatchObject({ code: 'not_found' })
      const items = await host.request<unknown[]>('mind.canvases.items.list', { canvasId: canvas.id })
      expect(items).toHaveLength(2)
    } finally { await host.close() }
  })

  it('桌面顶栏搜索合并 SQLite 字面匹配和工作区文件结果', async () => {
    const root = directory()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, join(root, 'core.db'))
    try {
      const files = desktopFiles(join(root, '工作区'))
      const personal = await files.personalRoot()
      mkdirSync(join(personal, '资料'))
      writeFileSync(join(personal, '资料', '测试_样本.md'), '合成正文')
      writeFileSync(join(root, '测试_库外.md'), '未绑定')
      await host.request('projects.board.create', { fields: { name: '测试_项目', status: 'active' } }, randomUUID())
      await host.request('projects.board.create', { fields: { name: '测试甲项目', status: 'active' } }, randomUUID())
      const search = workspaceHandlers(host, async () => null, files.globalFileSearch)[DESKTOP_CHANNELS.search]!
      await expect(search(['测试_'])).resolves.toMatchObject({
        total: 2,
        groups: [
          { type: 'project', items: [{ title: '测试_项目' }] },
          { type: 'file', items: [{ title: '测试_样本.md', path_file: { directoryId: 'personal', relativePath: '资料/测试_样本.md' } }] },
        ],
      })
      await expect(search(['资料'])).resolves.toMatchObject({ groups: expect.arrayContaining([
        expect.objectContaining({ type: 'folder', items: [expect.objectContaining({ title: '资料' })] }),
      ]) })
    } finally { await host.close() }
  })

  it('桌面 IM 图表经独立 Node Core 渲染并返回有效 PNG', async () => {
    const database = join(directory(), 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, database)
    try {
      const encoded = await host.request<string>('im.chart.render', { type: 'mermaid', source: 'graph TD; A-->B;' })
      const png = Buffer.from(encoded, 'base64')
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      expect(png.readUInt32BE(16)).toBeGreaterThan(0)
      await expect(host.request('im.chart.render', { type: 'unknown', source: 'synthetic' }))
        .rejects.toMatchObject({ code: 'invalid_request' })
    } finally { await host.close() }
  })

  it('桌面会话列表使用已绑定的 IM 平台分类，且仍能读取会话历史', async () => {
    const database = join(directory(), 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, database)
    try {
      // 同名普通会话仍归普通区域，平台来自持久化连接映射。
      const web = await host.request<{ id: number }>('agent.sessions.create', { title: '即时通讯' })
      const im = []
      for (const platform of ['wechat', 'qq', 'feishu', 'telegram']) {
        const scope = { platform, connectionId: 'a'.repeat(64) }
        await host.request('im.inbox.admit', { ...scope, eventKey: 'synthetic', sealedEvent: 'AQ==' })
        const { sessionId } = await host.request<{ sessionId: number }>('im.inbox.prepare', scope)
        im.push({ id: sessionId, source: platform, chatType: 'c2c' })
        await expect(host.request('agent.sessions.history', { id: sessionId })).resolves.toMatchObject({
          session: { chatType: 'c2c' }, messages: [],
        })
      }
      const sessions = await host.request('agent.sessions.list')
      expect(sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: web.id, source: 'web' }),
        ...im.map(session => expect.objectContaining(session)),
      ]))
      expect(sessions).toHaveLength(5)
      await host.request('im.inbox.recordGroup', {
        platform: 'qq', connectionId: 'b'.repeat(64), eventKey: 'c'.repeat(64),
        platformUserId: 'synthetic-member', platformUserName: '小北', text: '合成群消息',
      })
      const groups = await host.request<Array<{ id: number; chatType?: string }>>('agent.sessions.list')
      const group = groups.find(session => session.chatType === 'group')
      expect(group).toBeDefined()
      const groupScope = { platform: 'qq', connectionId: 'b'.repeat(64) }
      await host.request('im.inbox.recordGroup', {
        ...groupScope, eventKey: 'd'.repeat(64), platformUserId: 'synthetic-owner',
        ownerPlatformUserId: 'synthetic-owner', text: '合成本人消息',
      })
      await expect(host.request('im.inbox.recordGroup', {
        ...groupScope, eventKey: 'e'.repeat(64), platformUserId: 'synthetic-member',
        ownerPlatformUserId: 'synthetic-other', text: '错误配对消息',
      })).rejects.toMatchObject({ code: 'conflict' })
      await expect(host.request('agent.sessions.history', { id: group!.id })).resolves.toMatchObject({
        session: { chatType: 'group', ownerPlatformUserId: 'synthetic-owner' },
        messages: [
          { role: 'user', text: '合成群消息', platformUserId: 'synthetic-member', platformUserName: '小北' },
          { role: 'user', text: '合成本人消息', platformUserId: 'synthetic-owner' },
        ],
      })
      const replyGroup = { ...groupScope, connectionId: 'f'.repeat(64) }
      await host.request('im.inbox.admit', { ...replyGroup, eventKey: 'synthetic', sealedEvent: 'AQ==' })
      const { sessionId } = await host.request<{ sessionId: number }>('im.inbox.prepare', {
        ...replyGroup, chatType: 'group', ownerPlatformUserId: 'synthetic-owner',
      })
      await expect(host.request('agent.sessions.history', { id: sessionId })).resolves.toMatchObject({
        session: { chatType: 'group', ownerPlatformUserId: 'synthetic-owner' }, messages: [],
      })
    } finally { await host.close() }
  })

  it('Core 支持驼峰宿主方法名并能取消请求', async () => {
    const root = directory()
    const entry = join(root, 'cancel-host.mjs')
    writeFileSync(entry, `
      import { createInterface } from 'node:readline'
      const send = frame => process.stdout.write(JSON.stringify({ v: 2, ...frame }) + '\\n')
      send({ event: 'ready', schema: '${CORE_SCHEMA_VERSION}', capabilities: ['operation_receipts'] })
      createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line)
        if (request.event === 'host_response') return
        if (request.method !== 'runtime.close') {
          send({ event: 'host_request', requestId: 1, method: 'agent.memory.resolveReflectionModel', params: {} })
          send({ event: 'host_cancel', requestId: 1 })
        }
        send({ id: request.id, result: null })
      })
    `)
    const host = await launchCoreHost(process.execPath, entry, join(root, 'core.db'))
    try {
      let resolveCancelled!: () => void
      const cancelled = new Promise<void>(resolve => { resolveCancelled = resolve })
      host.setHostRequestHandler(async ({ method, signal }) => {
        expect(method).toBe('agent.memory.resolveReflectionModel')
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        resolveCancelled()
      })
      await host.request('preferences.desktop.get')
      await cancelled
    } finally { await host.close() }
  })

  it.each(['新会话', '旧版序号未同步的会话'])('桌面 Agent 的模型地址错误保留错误码，修正后可发送首条消息（%s）', async (scenario) => {
    const database = join(directory(), 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const provider = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: {"choices":[{"delta":{"content":"合成回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>(resolve => provider.close(() => resolve())))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('合成模型监听失败')
    let host = await launchCoreHost(process.execPath, entry, database)
    try {
      const { id } = await host.request<{ id: number }>('agent.sessions.create', { title: '合成对话', greeting: '合成开场白' })
      if (scenario === '旧版序号未同步的会话') {
        await host.close()
        const writer = new DatabaseSync(database)
        try { writer.prepare('UPDATE conversation_sessions SET last_message_seq=0 WHERE id=?').run(id) }
        finally { writer.close() }
        host = await launchCoreHost(process.execPath, entry, database)
      }
      host.setHostRequestHandler(async ({ method }) => {
        if (method === 'agent.tools.policy') return desktopAgentToolPolicy()
        if (method.endsWith('.available')) return false
        if (method === 'agent.log.append') return null
        if (method === 'agent.im.snapshot') return { qq: false, feishu: false, wechat: false, telegram: false }
        if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
        throw new Error('未预期的宿主请求')
      })
      const start = (base_url: string) => host.request<{ run_id: string }>('agent.sessions.startRun', {
        id, text: '合成查询', clientId: randomUUID(), interactive: true,
        model: { provider: 'local', api_format: 'openai', base_url, api_key: '', model: 'synthetic',
          context_tokens: 32_000, max_tokens: 512, web_search_enabled: false },
      })
      await expect(start('无效地址')).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(start('http://provider.example.test/v1')).rejects.toMatchObject({ code: 'invalid_request' })
      const { run_id: runId } = await start(`http://127.0.0.1:${address.port}/v1`)
      await vi.waitFor(async () => {
        expect(await host.request('agent.sessions.events', { id, runId, after: 0 }))
          .toMatchObject({ status: 'completed' })
      }, { timeout: 5000 })
      await expect(host.request('agent.sessions.messages', { id })).resolves.toEqual([
        expect.objectContaining({ role: 'assistant', text: '合成开场白' }),
        expect.objectContaining({ role: 'user', text: '合成查询' }),
        expect.objectContaining({ role: 'assistant', text: '合成回复' }),
      ])
    } finally { await host.close() }
  })

  it('桌面问候用本地近七天记忆生成，并校验请求语言', async () => {
    const database = join(directory(), 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule })
    const owner = runtime.ownerId.replaceAll('-', '')
    await runtime.close()
    const today = new Date().toISOString().slice(0, 10)
    const seed = new DatabaseSync(database)
    try {
      seed.prepare('INSERT INTO desktop_agent_memory_documents (user_id,target,body) VALUES (?,?,?)')
        .run(owner, 'daily', `## ${today}\n- 最近在练习手冲咖啡\n## 2000-01-01\n- 很久以前的合成记录`)
    } finally { seed.close() }

    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, database)
    const completeGreeting = vi.fn(async (_prompt: string, _signal: AbortSignal) => '「今天的咖啡喝得开心吗？」')
    try {
      const request = agentSessionHandlers(host, { completeGreeting } as ReturnType<typeof createDesktopAgentModelService>)[DESKTOP_CHANNELS.agentSessions]!
      await expect(request({ action: 'greeting', locale: 'en-US' }))
        .resolves.toEqual({ text: '今天的咖啡喝得开心吗？' })
      expect(completeGreeting).toHaveBeenCalledTimes(1)
      const prompt = completeGreeting.mock.calls[0]![0]
      expect(prompt).toContain('最近在练习手冲咖啡')
      expect(prompt).not.toContain('很久以前的合成记录')
      expect(prompt).toContain('natural English')
      const session = await request({ action: 'create', title: '合成问候会话', greeting: '今天的咖啡喝得开心吗？',
        operationId: randomUUID() }) as { id: number }
      await expect(request({ action: 'messages', id: session.id })).resolves.toEqual([
        expect.objectContaining({ role: 'assistant', text: '今天的咖啡喝得开心吗？' }),
      ])
      await expect(request({ action: 'greeting', locale: 'invalid' })).rejects.toMatchObject({ code: 'invalid_request' })
      expect(completeGreeting).toHaveBeenCalledTimes(1)
    } finally { await host.close() }
  })

  it('桌面宿主反向请求穿过 sidecar，支持 SSE 和搜索取消', async () => {
    const database = join(directory(), 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule })
    const ownerId = runtime.ownerId
    await runtime.close()
    const seedMemory = new DatabaseSync(database)
    try {
      seedMemory.prepare('INSERT INTO desktop_agent_memory (user_id,target,body) VALUES (?,?,?)')
        .run(ownerId.replaceAll('-', ''), 'profile', JSON.stringify([{ text: '偏好用简体中文交流' }]))
    } finally { seedMemory.close() }

    const knowledgeRoot = join(dirname(database), ownerId, '.agent', 'knowledge')
    const personalRoot = join(dirname(database), 'desktop-files', 'personal')
    mkdirSync(personalRoot, { recursive: true })
    writeFileSync(join(personalRoot, 'notes.txt'), '本机合成文件正文')
    mkdirSync(join(knowledgeRoot, 'entries'), { recursive: true })
    writeFileSync(join(knowledgeRoot, '.timestamps-iso-v1'), 'v1')
    writeFileSync(join(knowledgeRoot, 'entries', 'desktop-knowledge.md'), serializeAgentKnowledgeEntry({
      id: 'desktop-knowledge', title: '桌面知识接线', content: '知识正文只通过 owner 授权读取。',
      topic: '桌面', keywords: ['接线'], description: '用于本地 Agent 上下文验证',
      scope: { type: 'owner', owner_user_id: ownerId, platform: '', bot_id: '', group_id: '', scope_id: '', project_id: '' },
      source: { type: 'user', ref: '', label: '', checked_at: null }, confidence: 'confirmed',
      version: 1, parent_id: null, created_at: Date.now() / 1000, updated_at: Date.now() / 1000,
      active: true, history: [],
    }))
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    let server: Server | undefined
    let preview: Server | undefined
    const hostRequests: string[] = []
    const providerBodies: string[] = []
    let searchScenario: 'none' | 'research' | 'image' | 'local-image' | 'question' | 'skill-delete' | 'client-delete' | 'canvas-delete' | 'decision-guard' | 'tool-brief' | 'http-get' | 'web-download' = 'none'
    let researchRound = 0
    let questionRound = 0
    let webReadRound = 0
    let uploadedImageId = ''
    let localImageRound = 0
    let localImageReference: string | undefined
    let unreferencedImage: string | undefined
    let imageRequests = 0
    let imageModelRounds = 0
    let searchStarted!: () => void
    let searchCancelled!: () => void
    const searching = new Promise<void>(resolve => { searchStarted = resolve })
    const cancelled = new Promise<void>(resolve => { searchCancelled = resolve })
    try {
      const resources = resourceHandlers(host)[DESKTOP_CHANNELS.resources]!
      const canvas = await workspaceHandlers(host, async () => null)[DESKTOP_CHANNELS.createCanvas]!('合成画布') as { id: number }
      const memory = await agentSessionHandlers(host, {} as ReturnType<typeof createDesktopAgentModelService>)
        [DESKTOP_CHANNELS.agentSessions]!({ action: 'readMemory' })
      expect(memory).toMatchObject({ text: expect.stringContaining('偏好用简体中文交流') })
      const phrase = '偏好用简体中文交流'
      const previewForget = await host.request<{ count: number; revision: string }>('agent.memory.forget', { query: phrase })
      expect(previewForget.count).toBe(1)
      await expect(host.request('agent.memory.forget', { query: phrase, revision: '0'.repeat(64) }))
        .rejects.toMatchObject({ code: 'conflict' })
      await expect(host.request('agent.memory.read')).resolves.toMatchObject({ text: expect.stringContaining(phrase) })
      await expect(host.request('agent.memory.forget', { query: phrase, revision: previewForget.revision }))
        .resolves.toMatchObject({ count: 1 })
      await expect(host.request('agent.memory.read')).resolves.toEqual({ text: '' })
      await expect(workspaceHandlers(host, async () => null)[DESKTOP_CHANNELS.clearAgentMemory]!()).resolves.toBeNull()
      const project = await workspaceHandlers(host, async () => null)['gugu:projects:board:create']!(
        { name: '合成项目详情', status: 'active' }, randomUUID(),
      ) as { id: number }
      const externalPath = join(directory(), '合成拖入.txt')
      const externalText = '从原文件读到的合成正文'
      writeFileSync(externalPath, externalText)
      const openDropped = vi.fn(async () => '')
      const dropped = createDroppedFileReferences(dirname(database), openDropped)
      const droppedReference = await dropped.create(externalPath)
      const officePath = join(dirname(externalPath), '合成拖入.rtf')
      const officeText = 'Synthetic document excerpt'
      writeFileSync(officePath, String.raw`{\rtf1\ansi ${officeText}}`)
      const officeReference = await dropped.create(officePath)
      const fileReferences = [droppedReference, officeReference]
      expect(droppedReference).toMatchObject({ type: 'file', label: '合成拖入.txt' })
      expect(JSON.stringify(droppedReference)).not.toContain(externalPath)
      await expect(dropped.open(droppedReference.id)).resolves.toBeNull()
      expect(openDropped).toHaveBeenCalledWith(realpathSync(externalPath))

      host.setHostRequestHandler(async ({ method, params, signal }) => {
        hostRequests.push(method)
        if (method === 'agent.tools.policy') return desktopAgentToolPolicy()
        if (method === 'agent.files.resolveWorkspaceReference') return null
        if (method === 'agent.files.resolveDroppedReference') return dropped.resolve(params.id)
        if (method === 'agent.search.similar_image_search.available') return searchScenario === 'image'
        if (method === 'agent.search.deep_research.available') {
          expect(params).toEqual({})
          return searchScenario === 'research'
        }
        if (method === 'agent.search.similar_image_search') {
          imageRequests++
          expect(params).toMatchObject({ attach_id: uploadedImageId, max_results: 3 })
          return { kind: 'completed', successful: true, mutated: false, value: {
            results: [{ url: 'https://images.example.test/match.png' }],
          } }
        }
        if (method === 'agent.search.deep_research') {
          expect(params.query).toBe('合成查询')
          searchStarted()
          signal.throwIfAborted()
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          searchCancelled()
          return { kind: 'unknown' }
        }
        if (method === 'agent.files.projectOverview') {
          expect(params).toEqual({ projectId: project.id })
          return { total_file_count: 2, root_file_count: 1, total_folder_count: 1 }
        }
        if (method === 'agent.files.resolve') {
          if (params.path === '/personal/synthetic.png')
            return { name: 'synthetic.png', root: personalRoot, relativePath: 'synthetic.png', text: false, extensionless: false, extension: 'png' }
          expect(params).toEqual({ path: '/personal/notes.txt' })
          return { name: 'notes.txt', root: personalRoot, relativePath: 'notes.txt', text: true, extensionless: false, extension: 'txt' }
        }
        expect(params).toEqual({})
        if (method === 'agent.files.downloadTarget') return 'synthetic-download-target'
        if (method === 'agent.im.snapshot') return { feishu: true, qq: false, wechat: false, telegram: true }
        if (method === 'agent.files.overview') return {
          total: 1, folders: [],
          files: [{ name: '合成桌面文件.md', folder: null, space: 'personal' }], partial: false,
        }
        throw new Error('未预期的宿主请求')
      })
      const relatedTools: Array<{ name: string; description_short: string }> = []
      let toolOffset: number | null = 0
      while (toolOffset !== null) {
        const page = await resources({ domain: 'skills', action: 'tools', offset: toolOffset }) as
          { tools: typeof relatedTools; nextOffset: number | null }
        relatedTools.push(...page.tools)
        toolOffset = page.nextOffset
      }
      expect(relatedTools.map(tool => tool.name)).not.toContain('read_file')
      expect(relatedTools.map(tool => tool.name)).not.toContain('create_skill')
      const clientName = '合成联系人'
      const savedClient = await host.request<{ id: number }>('clients.create', { name: clientName })
      const savedSkill = await resources({
        domain: 'skills', action: 'create', fields: {
          name: '合成阅读技能', description_short: '读取合成文件', body: '使用知识读取工具。', related_tools: ['read_knowledge'],
        },
      }) as { id: string }
      await expect(resources({ domain: 'skills', action: 'list', offset: 0 })).resolves.toMatchObject({
        skills: [{ id: savedSkill.id, related_tools: ['read_knowledge'] }],
      })
      server = createServer((request, response) => {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          const payload = JSON.parse(body) as { stream?: boolean }
          if (payload.stream !== true) {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))
            return
          }
          const requestIndex = providerBodies.push(body) - 1
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          if (searchScenario === 'tool-brief') {
            const round = questionRound++
            const tool = [
              { name: 'search_tools', arguments: JSON.stringify({ query: 'get_current_time' }) },
              { name: 'call_tool', arguments: JSON.stringify({ tool_name: 'get_current_time', arguments: {} }) },
            ][round]
            const delta = tool ? { tool_calls: [{ index: 0, id: `brief-clock-${round}`, type: 'function', function: tool }] }
              : { content: '已查询当前时间。' }
            response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
          } else if (searchScenario === 'http-get' || searchScenario === 'web-download') {
            const first = webReadRound++ === 0
            const tool = searchScenario === 'http-get' ? 'http_get' : 'web_download'
            const delta = first ? { tool_calls: [{ index: 0, id: 'desktop-http-get', type: 'function', function: {
              name: tool, arguments: JSON.stringify({ url: 'http://127.0.0.1/' }),
            } }] } : { content: '已处理网页读取结果' }
            response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
          } else if (searchScenario === 'decision-guard') {
            const content = questionRound++ === 0 ? '这个不需要重新排序，已经挺合理的了。' : '建议将有截止日期的任务排在前面。'
            response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
          } else if (searchScenario === 'skill-delete' || searchScenario === 'client-delete' || searchScenario === 'canvas-delete') {
            const asking = questionRound++ === 0
            const delta = asking ? { tool_calls: [{ index: 0, id: 'desktop-delete', type: 'function', function: {
              ...(searchScenario === 'client-delete'
                ? { name: 'delete_client', arguments: JSON.stringify({ client_id: savedClient.id }) }
                : searchScenario === 'canvas-delete'
                  ? { name: 'canvas_delete', arguments: JSON.stringify({ canvas_ids: [canvas.id] }) }
                  : { name: 'delete_skill', arguments: JSON.stringify({ id: savedSkill.id }) }),
            } }] } : { content: '删除操作已收尾' }
            response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: asking ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
          } else if (searchScenario === 'question') {
            const asking = questionRound++ === 0
            const delta = asking ? { tool_calls: [{ index: 0, id: 'desktop-question', type: 'function', function: {
              name: 'ask_user', arguments: JSON.stringify({ kind: 'question', title: '确认称呼', body: '请提供称呼' }),
            } }] } : { content: '已收到称呼并继续' }
            response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: asking ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
          } else if (searchScenario === 'local-image') {
            const round = localImageRound++
            const reading = round < 2
            const delta = reading
              ? { tool_calls: [{ index: 0, id: `desktop-image-view-${round}`, type: 'function', function: {
                name: 'view_image', arguments: JSON.stringify(localImageReference
                  ? { path: round === 0 ? unreferencedImage : localImageReference }
                  : round === 0 ? { attach_id: uploadedImageId } : { path: '/personal/synthetic.png' }),
              } }] }
              : { content: '已查看本机图片' }
            response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reading ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
          } else if (searchScenario === 'image') {
            const firstRound = imageModelRounds++ === 0
            const delta = firstRound
              ? { tool_calls: [{ index: 0, id: 'desktop-image', type: 'function', function: {
                name: 'similar_image_search', arguments: JSON.stringify({ attach_id: uploadedImageId, max_results: 3 }),
              } }] }
              : { content: '已找到相似图片' }
            response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: firstRound ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
          } else if (searchScenario === 'research') {
            const discovering = researchRound++ === 0
            const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: discovering ? 'desktop-search-schema' : 'desktop-search', type: 'function',
              function: discovering
                ? { name: 'search_tools', arguments: '{"names":["deep_research"]}' }
                : { name: 'deep_research', arguments: '{"query":"合成查询"}' },
            }] }, finish_reason: 'tool_calls' }] }
            response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`)
          } else if (requestIndex < 2) {
            const listing = requestIndex === 0
            const delta = { choices: [{ delta: { tool_calls: [{
              index: 0, id: listing ? 'desktop-skills-list' : 'desktop-skill-load', type: 'function',
              function: listing
                ? { name: 'list_skills', arguments: '{}' }
                : { name: 'use_skill', arguments: JSON.stringify({ id: savedSkill.id }) },
            }] }, finish_reason: 'tool_calls' }] }
            response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`)
          } else if (requestIndex === 2) {
            const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'desktop-knowledge-read', type: 'function',
              function: { name: 'read_knowledge', arguments: '{"knowledge_id":"desktop-knowledge"}' },
            }] }, finish_reason: 'tool_calls' }] }
            response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`)
          } else if (requestIndex === 3) {
            const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'desktop-current-time', type: 'function',
              function: { name: 'get_current_time', arguments: '{}' },
            }] }, finish_reason: 'tool_calls' }] }
            response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`)
          } else if (requestIndex === 4) {
            const args = { message: '合成入口', buttons: [{ id: 'docs', label: '查看资料', url: 'https://example.com/docs' }] }
            const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'desktop-link-buttons', type: 'function',
              function: { name: 'send_link_buttons', arguments: JSON.stringify(args) },
            }] }, finish_reason: 'tool_calls' }] }
            response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`)
          } else if (requestIndex === 5) {
            const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'desktop-project-read', type: 'function',
              function: { name: 'get_project', arguments: JSON.stringify({ project_id: project.id }) },
            }] }, finish_reason: 'tool_calls' }] }
            response.end(`data: ${JSON.stringify(delta)}\n\ndata: [DONE]\n\n`)
          } else {
            response.end('data: {"choices":[{"delta":{"content":"sidecar SSE、知识和文件工具已连通"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          }
        })
      })
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
      const session = await host.request<{ id: number }>('agent.sessions.create', { title: '桌面宿主接线验证' })
      const queueId = `session-${session.id}`
      const queue = agentSessionHandlers(host, {} as ReturnType<typeof createDesktopAgentModelService>)[DESKTOP_CHANNELS.agentSessions]!
      const queuedText = '合成待发消息'
      const queuedModelId = 'queued-model'
      const socketPath = process.platform === 'win32' ? String.raw`\\.\pipe\gugu-${randomUUID()}` : join(dirname(database), 'preview.sock')
      const secret = 'synthetic-attachment-preview'
      preview = await startDesktopPreviewAgent(socketPath, secret, desktopAgentAttachmentHandlers(host, dirname(database)))
      const textAttachment = '由预览上传的合成文本附件'
      const upload = await requestPreviewAttachment(socketPath, secret, Buffer.from(textAttachment), {
        'Content-Type': 'application/octet-stream', 'x-gugu-attachment-name': encodeURIComponent('合成附件.txt'),
        'x-gugu-attachment-type': 'text/plain',
      })
      expect(upload).toMatchObject({ ok: true, result: { attach_id: expect.stringMatching(/^[0-9a-f]{32}$/) } })
      const queuedAttachment = (upload as { result: { attach_id: string } }).result
      const attachId = queuedAttachment.attach_id
      const reference = { type: 'file', id: `path-${Buffer.from(JSON.stringify({
        relativePath: 'notes.txt', identity: '1.2.3',
      })).toString('base64url')}`, label: '本机路径引用' }
      await queue({
        action: 'queue', queueAction: 'patch', queueId, sessionId: session.id,
        items: [{ key: 1, text: queuedText, modelId: queuedModelId, attachments: [queuedAttachment], references: [reference] }], removedKeys: [], operationId: randomUUID(),
      })
      const claim = await queue({
        action: 'queue', queueAction: 'claim', queueId, sessionId: session.id, key: 1, operationId: randomUUID(),
      }) as { claimToken: string }
      expect(claim.claimToken).toEqual(expect.any(String))
      await expect(queue({ action: 'queue', queueAction: 'read', queueId })).resolves.toMatchObject({
        items: [{ modelId: queuedModelId, attachments: [{ attach_id: attachId, duration: null, img_width: null }], references: [reference] }],
      })
      await host.request('preferences.desktop.update', { patch: { timezone: 'Pacific/Kiritimati', toolInjectionMode: 'full' } })
      const run = await host.request<{ run_id: string }>('agent.sessions.startRun', {
        id: session.id,
        text: queuedText,
        queueClaim: { key: 1, token: claim.claimToken },
        clientId: 'desktop-host-rpc-test',
        modelId: queuedModelId,
        attachments: [attachId],
        references: [reference],
        model: {
          provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
          api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512,
          web_search_enabled: false,
        },
      })
      let page = await host.request<{ status: string; events: Array<{ type: string }> }>('agent.sessions.events', {
        id: session.id, runId: run.run_id, after: 0,
      })
      const deadline = Date.now() + 10_000
      while (page.status !== 'completed' && page.status !== 'failed' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
        page = await host.request('agent.sessions.events', { id: session.id, runId: run.run_id, after: 0 })
      }
      expect(page, JSON.stringify({ events: page.events, hostRequests, providerCount: providerBodies.length }))
        .toMatchObject({ status: 'completed' })
      await expect(host.request('agent.sessions.runModel', { id: session.id, runId: run.run_id })).resolves.toBe(queuedModelId)
      await expect(queue({ action: 'queue', queueAction: 'read', queueId })).resolves.toBeNull()
      expect(providerBodies[0]).toContain(queuedText)
      expect(providerBodies[0]).toContain(reference.label)
      expect(providerBodies).toHaveLength(7)
      expect(hostRequests).toContain('agent.im.snapshot')
      expect(providerBodies[0]).toContain('飞书：已连')
      expect(providerBodies[0]).toContain('QQ：未连')
      expect(providerBodies[0]).toContain('Telegram：已连')
      expect(hostRequests).toContain('agent.files.overview')
      expect(hostRequests).not.toContain('agent.files.resolve')
      expect(providerBodies.join('\n')).toContain('合成桌面文件.md')
      expect(providerBodies.join('\n')).toContain('桌面知识接线')
      const firstRequest = JSON.parse(providerBodies[0]!) as { tools?: Array<{ function?: { name?: string } }> }
      expect(firstRequest.tools?.some(tool => tool.function?.name === 'read_knowledge')).toBe(true)
      expect(firstRequest.tools?.some(tool => tool.function?.name === 'read_file')).toBe(false)
      expect(firstRequest.tools?.map(tool => tool.function?.name)).not.toContain('deep_research')
      expect(firstRequest.tools?.map(tool => tool.function?.name)).not.toContain('similar_image_search')
      expect(page.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool_done', name: 'list_skills', status: 'success' }),
        expect.objectContaining({ type: 'tool_done', name: 'use_skill', status: 'success' }),
      ]))
      expect(providerBodies[1]).toContain('合成阅读技能')
      expect(providerBodies[2]).toContain('使用知识读取工具。')
      expect(providerBodies[3]).toContain('知识正文只通过 owner 授权读取。')
      expect(providerBodies[4]).not.toContain('本机合成文件正文')
      expect(providerBodies[4]).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
      expect(providerBodies[4]).not.toContain('Pacific/Kiritimati')
      expect(page.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool_done', name: 'get_project', status: 'success' }),
      ]))
      expect(providerBodies[6]?.includes('【文件总数】2')).toBe(true)
      expect(providerBodies[6]?.includes('【根目录文件数】1')).toBe(true)
      expect(providerBodies[6]?.includes('找到项目「合成项目详情」')).toBe(true)
      await expect(host.request('agent.sessions.messages', { id: session.id }))
        .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: expect.stringContaining('文件工具已连通') })]))
      const history = await host.request('agent.sessions.history', { id: session.id })
      expect(history).toMatchObject({ active: false, messages: expect.arrayContaining([
        expect.objectContaining({ assistantTimeline: expect.arrayContaining([
          expect.objectContaining({ linkButtons: expect.objectContaining({ kind: 'link_buttons', message: '合成入口' }) }),
        ]) }),
      ]) })
      expect(providerBodies[0]).toContain(textAttachment)
      const draftAttachment = await requestPreviewAttachment(socketPath, secret, Buffer.from('合成未发送内容'), {
        'Content-Type': 'application/octet-stream', 'x-gugu-attachment-name': 'synthetic-draft.txt',
        'x-gugu-attachment-type': 'text/plain',
      }) as { ok: boolean; result: { attach_id: string } }
      expect(draftAttachment.ok).toBe(true)
      const draftId = draftAttachment.result.attach_id
      const draftPath = join(dirname(database), 'agent-attachments', draftId)
      expect(readFileSync(draftPath, 'utf8')).toBe('合成未发送内容')
      const clearAttachments = workspaceHandlers(host, async () => null)[DESKTOP_CHANNELS.clearAgentAttachments]!
      await expect(clearAttachments()).resolves.toEqual({ deleted: 1 })
      await expect(clearAttachments()).resolves.toEqual({ deleted: 0 })
      await expect(host.request('agent.attachments.deleteDraft', { attach_id: draftId })).resolves.toBeNull()
      expect(() => readFileSync(draftPath)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
      expect((await dropped.resolve(droppedReference.id))?.path).toBe(realpathSync(externalPath))
      const downloaded = await requestPreviewAttachment(socketPath, secret,
        JSON.stringify({ action: 'download', attachId }), { 'Content-Type': 'application/json' })
      expect(downloaded).toMatchObject({
        ok: true, result: { name: '合成附件.txt', mime: 'text/plain', data: Buffer.from(textAttachment).toString('base64') },
      })
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zr6sAAAAASUVORK5CYII=', 'base64')
      writeFileSync(join(personalRoot, 'synthetic.png'), png)
      const uploadedImage = await requestPreviewAttachment(socketPath, secret, png, {
        'Content-Type': 'application/octet-stream', 'x-gugu-attachment-name': 'synthetic.png',
        'x-gugu-attachment-type': 'image/png',
      }) as { ok: boolean; result: { attach_id: string } }
      expect(uploadedImage.ok).toBe(true)
      uploadedImageId = uploadedImage.result.attach_id
      searchScenario = 'local-image'
      const photoSession = await host.request<{ id: number }>('agent.sessions.create', { title: '仅图片消息' })
      const model = {
        async resolveRunModelSelection() {
          return { id: 'synthetic-model', config: {
            provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
            api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512, image: true,
          } }
        },
      } as ReturnType<typeof createDesktopAgentModelService>
      const sessionHandler = agentSessionHandlers(host, model)[DESKTOP_CHANNELS.agentSessions]!
      const photoEvents: unknown[] = []
      const photoRequestIndex = providerBodies.length
      const photoMessages = await sessionHandler({
        action: 'send', id: photoSession.id, text: '', attachments: [uploadedImageId], operationId: randomUUID(), stream: true,
      }, (event: unknown) => photoEvents.push(event))
      expect(photoEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'session_id', session_id: photoSession.id }),
        expect.objectContaining({ type: 'projected', event: expect.objectContaining({ type: 'tool_done', name: 'view_image', status: 'success' }) }),
      ]))
      expect(photoEvents.filter(event => {
        const frame = event as { type?: string; event?: { type?: string; name?: string; status?: string } }
        return frame.type === 'projected' && frame.event?.type === 'tool_done'
          && frame.event.name === 'view_image' && frame.event.status === 'success'
      })).toHaveLength(2)
      expect(photoMessages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: '', files: [expect.objectContaining({ attach_id: uploadedImageId })] }),
        expect.objectContaining({ role: 'assistant', text: '已查看本机图片' }),
      ]))
      expect(providerBodies[photoRequestIndex]).toContain(uploadedImageId)
      expect(providerBodies[photoRequestIndex + 1]!.includes(`data:image/png;base64,${png.toString('base64')}`)).toBe(true)
      localImageRound = 0
      const photoReferencePath = join(directory(), '合成引用图片.png')
      writeFileSync(photoReferencePath, png)
      localImageReference = realpathSync(photoReferencePath)
      const unreferencedPath = join(directory(), '未引用的合成图.png')
      writeFileSync(unreferencedPath, png)
      unreferencedImage = realpathSync(unreferencedPath)
      const pathInProviderBody = (path: string) => JSON.stringify(JSON.stringify(path)).slice(1, -1)
      const photoReference = await dropped.create(photoReferencePath)
      const referencePhotoSession = await host.request<{ id: number }>('agent.sessions.create', { title: '原图引用' })
      const referenceEvents: unknown[] = []
      const referenceRequestIndex = providerBodies.length
      await sessionHandler({
        action: 'send', id: referencePhotoSession.id, text: '', references: [photoReference], operationId: randomUUID(), stream: true,
      }, (event: unknown) => referenceEvents.push(event))
      expect(referenceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'projected', event: expect.objectContaining({ type: 'tool_done', name: 'view_image', status: 'error' }) }),
        expect.objectContaining({ type: 'projected', event: expect.objectContaining({ type: 'tool_done', name: 'view_image', status: 'success' }) }),
      ]))
      expect(providerBodies[referenceRequestIndex]).toContain(pathInProviderBody(localImageReference))
      expect(providerBodies[referenceRequestIndex]).not.toContain('/references/1')
      expect(providerBodies[referenceRequestIndex + 1]).not.toContain('data:image/png;base64,')
      expect(providerBodies[referenceRequestIndex + 2]).toContain(`data:image/png;base64,${png.toString('base64')}`)

      localImageRound = 0
      const followUpIndex = providerBodies.length
      const followUpEvents: DesktopAgentChatEvent[] = []
      await sessionHandler({
        action: 'send', id: referencePhotoSession.id, text: '再试试', operationId: randomUUID(), stream: true,
      }, (event: DesktopAgentChatEvent) => followUpEvents.push(event))
      expect(providerBodies[followUpIndex]).toContain('最近明确引用的图片')
      expect(providerBodies[followUpIndex + 2]).toContain(`data:image/png;base64,${png.toString('base64')}`)
      expect(followUpEvents).toContainEqual(expect.objectContaining({ type: 'projected',
        event: expect.objectContaining({ type: 'tool_done', name: 'view_image', status: 'success' }) }))


      searchScenario = 'http-get'
      const webRead = await host.request<{ id: number }>('agent.sessions.create', { title: '公网网页读取' })
      const webReadEvents: DesktopAgentChatEvent[] = []
      const webReadRequestIndex = providerBodies.length
      await sessionHandler({ action: 'send', id: webRead.id, text: '读取合成网页', operationId: randomUUID(), stream: true },
        (event: DesktopAgentChatEvent) => webReadEvents.push(event))
      expect(webReadEvents).toContainEqual(expect.objectContaining({ type: 'projected',
        event: expect.objectContaining({ type: 'tool_done', name: 'http_get' }) }))
      expect(providerBodies[webReadRequestIndex + 1]).toContain('目标地址或请求未通过公网访问校验')

      searchScenario = 'web-download'
      webReadRound = 0
      const downloadSession = await host.request<{ id: number }>('agent.sessions.create', { title: '公网下载' })
      const downloadEvents: DesktopAgentChatEvent[] = []
      await sessionHandler({ action: 'send', id: downloadSession.id, text: '下载合成文件', operationId: randomUUID(), stream: true },
        (event: DesktopAgentChatEvent) => downloadEvents.push(event))
      expect(downloadEvents).toContainEqual(expect.objectContaining({ type: 'projected',
        event: expect.objectContaining({ type: 'tool_done', name: 'web_download', status: 'error' }) }))
      expect(hostRequests).toContain('agent.files.downloadTarget')
      expect(hostRequests).not.toContain('agent.files.commitDownload')

      await expect(host.request('agent.memory.invalidateEmbedding')).resolves.toBeNull()
      searchScenario = 'research'
      const searchSession = await host.request<{ id: number }>('agent.sessions.create', { title: '取消远程搜索' })
      const searchRun = await host.request<{ run_id: string }>('agent.sessions.startRun', {
        id: searchSession.id, text: '查找合成资料', clientId: 'desktop-search-cancel-test',
        model: {
          provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
          api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512,
        },
      })
      await searching
      const searchEvents = await host.request<DesktopAgentEventPage>('agent.sessions.events', {
        id: searchSession.id, runId: searchRun.run_id, after: 0,
      })
      expect(searchEvents.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool_done', name: 'search_tools', status: 'success' }),
      ]))
      expect(hostRequests).toEqual(expect.arrayContaining([
        'agent.search.deep_research.available', 'agent.search.similar_image_search.available',
      ]))
      await expect(host.request('agent.sessions.cancelRun', { id: searchSession.id, runId: searchRun.run_id }))
        .resolves.toMatchObject({ outcome: 'requested' })
      await cancelled
      const searchImage = await requestPreviewAttachment(socketPath, secret, png, {
        'Content-Type': 'application/octet-stream', 'x-gugu-attachment-name': 'search.png',
        'x-gugu-attachment-type': 'image/png',
      }) as { ok: boolean; result: { attach_id: string } }
      expect(searchImage.ok).toBe(true)
      uploadedImageId = searchImage.result.attach_id
      searchScenario = 'image'
      const imageSession = await host.request<{ id: number }>('agent.sessions.create', { title: '远程相似图片' })
      const imageRun = await host.request<{ run_id: string }>('agent.sessions.startRun', {
        id: imageSession.id, text: '查找相似图片', clientId: 'desktop-image-search-test', attachments: [uploadedImageId],
        model: {
          provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
          api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512,
        },
      })
      await vi.waitFor(async () => {
        const page = await host.request<DesktopAgentEventPage>('agent.sessions.events', {
          id: imageSession.id, runId: imageRun.run_id, after: 0,
        })
        expect(page.status).toBe('completed')
        expect(page.events).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'tool_done', name: 'similar_image_search', status: 'success' }),
        ]))
      }, { timeout: 5_000 })
      expect(imageRequests).toBe(1)
      expect(providerBodies.some(body => body.includes('https://images.example.test/match.png'))).toBe(true)

      searchScenario = 'question'
      const questionSession = await host.request<{ id: number }>('agent.sessions.create', { title: '澄清问题续接' })
      const questionModel = {
        provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
        api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 512,
      } as const
      const questions = agentSessionHandlers(host, {
        resolveRunModel: async () => questionModel,
        resolveRunModelSelection: async () => ({ id: 'synthetic-model', config: questionModel }),
      } as ReturnType<typeof createDesktopAgentModelService>)[DESKTOP_CHANNELS.agentSessions]!
      const questionEvents: DesktopAgentChatEvent[] = []
      const receiveQuestionEvent = (event: DesktopAgentChatEvent) => questionEvents.push(event)
      await questions({ action: 'send', id: questionSession.id, text: '先询问我的称呼', stream: true, operationId: randomUUID() }, receiveQuestionEvent)
      const runId = questionEvents.find(event => event.type === 'session_id')?.run_id
      const prompt = questionEvents.find(event => event.type === 'projected' && event.event.type === 'interaction_required')
      expect(prompt).toMatchObject({
        event: { title: '确认称呼', allow_text_input: true, prompt_id: expect.any(Number) },
      })
      expect(runId).toEqual(expect.any(String))
      const questionIdentity = { id: questionSession.id, runId }
      const promptId = Number(prompt?.type === 'projected' && prompt.event.prompt_id)
      await expect(host.request('agent.sessions.events', { ...questionIdentity, stateOnly: true }))
        .resolves.toMatchObject({ status: 'waiting' })
      await expect(questions({ action: 'history', id: questionSession.id })).resolves.toMatchObject({
        messages: expect.arrayContaining([expect.objectContaining({
          interactions: expect.arrayContaining([expect.objectContaining({
            id: promptId, run_id: runId, resolved: false, allow_text_input: true,
          })]),
        })]),
      })
      const answer = '请称呼我小北'
      await expect(questions({ action: 'respond', ...questionIdentity, promptId, text: answer, operationId: randomUUID() }))
        .resolves.toMatchObject({ runId, awaitingText: false })
      questionEvents.length = 0
      await questions({ action: 'resume', ...questionIdentity, operationId: randomUUID() }, receiveQuestionEvent)
      expect(questionEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'projected', event: expect.objectContaining({
          type: 'interaction_required', prompt_id: promptId, resolved: true, response_text: answer,
        }) }),
        expect.objectContaining({ type: 'content', text: '已收到称呼并继续' }),
      ]))
      expect(providerBodies.at(-1)).toContain(answer)
      await expect(host.request('agent.sessions.messages', { id: questionSession.id })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', text: '已收到称呼并继续' }),
      ]))

      searchScenario = 'decision-guard'
      const guardSession = await host.request<{ id: number }>('agent.sessions.create', { title: '合成决策守卫' })
      const replyStyle = '合成风格偏好：回答先写一行摘要。'
      await host.request('preferences.desktop.update', { patch: { customReplyStyle: replyStyle } })
      for (const [index, enabled] of [false, true, false].entries()) {
        await expect(host.request('preferences.desktop.update', { patch: { decisionGuardEnabled: enabled, customReplyStyleEnabled: enabled } }))
          .resolves.toMatchObject({ decisionGuardEnabled: enabled })
        questionRound = 0
        const guardRequestIndex = providerBodies.length
        const { run_id: guardRunId } = await host.request<{ run_id: string }>('agent.sessions.startRun', {
          id: guardSession.id, text: '帮我把这些任务重新排序一下', clientId: `desktop-guard-${index}`, model: questionModel,
        })
        await vi.waitFor(async () => {
          await expect(host.request('agent.sessions.events', { id: guardSession.id, runId: guardRunId, stateOnly: true }))
            .resolves.toMatchObject({ status: 'completed' })
        }, { timeout: 5_000 })
        expect(questionRound).toBe(enabled ? 2 : 1)
        expect(providerBodies[guardRequestIndex]?.includes(replyStyle)).toBe(enabled)
      }

      searchScenario = 'tool-brief'
      questionRound = 0
      const briefRequestIndex = providerBodies.length
      await expect(host.request('preferences.desktop.update', { patch: { toolInjectionMode: 'description' } }))
        .resolves.toMatchObject({ toolInjectionMode: 'description' })
      const { run_id: briefRunId } = await host.request<{ run_id: string }>('agent.sessions.startRun', {
        id: guardSession.id, text: '', references: fileReferences, clientId: 'desktop-brief', model: questionModel,
      })
      await vi.waitFor(async () => {
        await expect(host.request('agent.sessions.events', { id: guardSession.id, runId: briefRunId, after: 0 }))
          .resolves.toMatchObject({ status: 'completed', events: expect.arrayContaining([
            expect.objectContaining({ type: 'tool_done', name: 'search_tools', status: 'success' }),
            expect.objectContaining({ type: 'tool_done', name: 'get_current_time', status: 'success' }),
          ]) })
      }, { timeout: 5_000 })
      const briefRequest = JSON.parse(providerBodies[briefRequestIndex]!) as typeof firstRequest
      const names = briefRequest.tools?.map(tool => tool.function?.name)
      expect(names).toContain('call_tool')
      expect(names).toContain('search_tools')
      expect(names).not.toContain('get_tool_schema')
      expect(names).not.toContain('get_current_time')
      expect(names).not.toContain('read_knowledge')
      expect(providerBodies[briefRequestIndex]).toContain('当前可用工具简介')
      expect(providerBodies[briefRequestIndex + 1]).toContain('[canonical tool-schema]')
      expect(providerBodies[briefRequestIndex + 1]).toContain('工具名：get_current_time')
      expect(providerBodies[briefRequestIndex]).toContain(externalText)
      expect(providerBodies[briefRequestIndex]).toContain(pathInProviderBody(realpathSync(externalPath)))
      expect(providerBodies[briefRequestIndex]).toContain(officeText)
      expect(providerBodies[briefRequestIndex]).toContain(pathInProviderBody(realpathSync(officePath)))
      await expect(host.request('agent.sessions.messages', { id: guardSession.id })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', references: fileReferences }),
      ]))
      const replacement = externalPath + '.replace'
      writeFileSync(replacement, '替换后的文件')
      const { renameSync } = await import('node:fs')
      renameSync(replacement, externalPath)
      await expect(dropped.resolve(droppedReference.id)).resolves.toBeNull()
      await expect(dropped.open(droppedReference.id)).rejects.toMatchObject({ code: 'not_found' })
      expect(openDropped).toHaveBeenCalledOnce()
      expect(providerBodies[briefRequestIndex + 2]).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
      expect(providerBodies[briefRequestIndex + 2]).not.toContain('Pacific/Kiritimati')
      await host.request('preferences.desktop.update', { patch: { toolInjectionMode: 'full' } })

      const deleteTargets = [
        { scenario: 'skill-delete', tool: 'delete_skill', id: savedSkill.id, name: '合成阅读技能',
          list: async () => (await resources({ domain: 'skills', action: 'list' }) as { skills: Array<{ id: number }> }).skills },
        { scenario: 'client-delete', tool: 'delete_client', id: savedClient.id, name: clientName,
          list: () => host.request<Array<{ id: number }>>('clients.list') },
        { scenario: 'canvas-delete', tool: 'canvas_delete', id: canvas.id, name: '删除画布及其内容',
          list: () => host.request<Array<{ id: number }>>('mind.canvases.list') },
      ] as const
      for (const target of deleteTargets) {
        searchScenario = target.scenario
        for (const choice of ['cancel', 'confirm']) {
          questionRound = 0
          const deleteSession = await host.request<{ id: number }>('agent.sessions.create', { title: '删除确认' })
          questionEvents.length = 0
          await questions({ action: 'send', id: deleteSession.id, text: `移除${target.name}`, stream: true, operationId: randomUUID() }, receiveQuestionEvent)
          const deleteRunId = questionEvents.find(event => event.type === 'session_id')?.run_id
          const deletePrompt = questionEvents.find(event => event.type === 'projected' && event.event.type === 'interaction_required')
          expect(deletePrompt).toMatchObject({ event: {
            kind: 'confirm', body: expect.stringContaining(target.name),
            options: expect.arrayContaining([expect.objectContaining({ id: choice, token: expect.any(String) })]),
          } })
          expect(await target.list()).toContainEqual(expect.objectContaining({ id: target.id }))
          const promptFields = deletePrompt?.type === 'projected' ? deletePrompt.event : undefined
          const confirmationToken = (promptFields?.options as Array<{ id: string; token: string }>)
            .find(option => option.id === choice)?.token
          const deleteIdentity = { id: deleteSession.id, runId: deleteRunId }
          await expect(questions({
            action: 'respond', ...deleteIdentity, promptId: promptFields?.prompt_id, token: confirmationToken, operationId: randomUUID(),
          })).resolves.toMatchObject({ runId: deleteRunId, awaitingText: false })
          await questions({ action: 'resume', ...deleteIdentity, operationId: randomUUID() }, receiveQuestionEvent)
          if (choice === 'confirm') {
            expect(questionEvents).toContainEqual(expect.objectContaining({
              type: 'projected', event: expect.objectContaining({ type: 'tool_done', name: target.tool, status: 'success' }),
            }))
          } else {
            expect(await target.list()).toContainEqual(expect.objectContaining({ id: target.id }))
          }
        }
        expect(await target.list()).not.toContainEqual(expect.objectContaining({ id: target.id }))
      }

      searchScenario = 'question'
      questionRound = 0
      const expiredSession = await host.request<{ id: number }>('agent.sessions.create', { title: '过期交互恢复' })
      questionEvents.length = 0
      await questions({ action: 'send', id: expiredSession.id, text: '请先询问称呼', stream: true, operationId: randomUUID() }, receiveQuestionEvent)
      const expiredPrompt = questionEvents.find(event => event.type === 'projected' && event.event.type === 'interaction_required')
      expect(expiredPrompt).toMatchObject({ event: { prompt_id: expect.any(Number), resolved: false } })
      const expiredPromptId = Number(expiredPrompt?.type === 'projected' && expiredPrompt.event.prompt_id)
      await host.close()
      const clockFixture = new DatabaseSync(database)
      const expiresAt = Date.now() + 5_000
      try {
        clockFixture.prepare('UPDATE interaction_prompts SET expires_at=? WHERE id=? AND session_id=?')
          .run(new Date(expiresAt).toISOString(), expiredPromptId, expiredSession.id)
      } finally { clockFixture.close() }
      host = await launchCoreHost(process.execPath, entry, database)
      const recovered = agentSessionHandlers(host, {} as ReturnType<typeof createDesktopAgentModelService>)[DESKTOP_CHANNELS.agentSessions]!
      await expect(recovered({ action: 'history', id: expiredSession.id })).resolves.toMatchObject({
        messages: expect.arrayContaining([expect.objectContaining({
          interactions: expect.arrayContaining([expect.objectContaining({ id: expiredPromptId, resolved: false })]),
        })]),
      })
      const waitingQueue = { action: 'queue', queueId: `session-${expiredSession.id}`, sessionId: expiredSession.id }
      await recovered({
        ...waitingQueue, queueAction: 'patch', operationId: randomUUID(),
        items: [{ key: 1, text: '等交互结束再发送' }], removedKeys: [],
      })
      const claimWaitingQueue = () => recovered({ ...waitingQueue, queueAction: 'claim', operationId: randomUUID(), key: 1 })
      await expect(claimWaitingQueue()).resolves.toMatchObject({ claimToken: null, reason: 'session_active' })
      const requestCount = providerBodies.length
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 20))
      await expect(claimWaitingQueue()).resolves.toMatchObject({ claimToken: expect.any(String) })
      await expect(recovered({ action: 'history', id: expiredSession.id })).resolves.toMatchObject({
        active: false, executionState: 'idle',
        messages: expect.arrayContaining([expect.objectContaining({
          interactions: expect.arrayContaining([expect.objectContaining({
            id: expiredPromptId, expired: true, resolved: true, options: [],
          })]),
        })]),
      })
      expect(providerBodies).toHaveLength(requestCount)

    } finally {
      if (preview) await new Promise<void>(resolve => preview!.close(() => resolve()))
      await host.close()
      if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    }
  })

  it('桌面重启后补跑中断的反思，且只召回尚未删除的记忆', async () => {
    const database = join(directory(), 'core.db')
    const { initializeSqlite, openSqliteRuntime } = await import('../../../packages/core/dist/data/sqlite.js')
    const { createDesktopAgentSession } = await import('../../../packages/core/dist/agent/sessions/desktop.js')
    const { createSqliteAgentAdmission } = await import('../../../packages/core/dist/agent/run/sqlite-admission.js')
    const providerRequests: string[] = []
    const chatRequests: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (JSON.parse(body).stream) {
          chatRequests.push(body)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '合成下一轮回复' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
          return
        }
        providerRequests.push(body)
        response.setHeader('content-type', 'application/json')
        const content = JSON.stringify(body.includes('合成用户偏好 1')
          ? { profile_add: [{ text: '偏好使用合成日程模板', type: 'preference' }] } : {})
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
    const config = { provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic' }
    const modelIdentity = createHash('sha256').update(JSON.stringify([config.provider, config.api_format, config.base_url, config.model])).digest('hex')
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    const owner = ownerId.replaceAll('-', '')
    const contracts = []
    try {
      for (const attempts of [1, 3]) {
        const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成反思会话'))
        const turn = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
          session_id: session.id, message: `合成用户偏好 ${attempts}`,
        })
        contracts.push({ sessionId: session.id, runId: turn.identity.runId, userMessageId: turn.userMessageId, attempts })
      }
    } finally { await runtime.close() }
    const seed = new DatabaseSync(database)
    try {
      const statement = seed.prepare(`INSERT INTO desktop_agent_reflection_jobs
        (user_id,session_id,run_id,user_message_id,model_identity,assistant_text,status,attempts,created_at_ms,claimed_at_ms)
        VALUES(?,?,?,?,?,?,'processing',?,?,?)`)
      for (const item of contracts) statement.run(owner, item.sessionId, item.runId, item.userMessageId, modelIdentity,
        '合成助手回复', item.attempts, Date.now(), Date.now())
    } finally { seed.close() }
    const host = await launchCoreHost(process.execPath, resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js'), database)
    try {
      host.setHostRequestHandler(async ({ method }) => {
        if (method === 'agent.memory.resolveReflectionModel') return config
        if (method === 'agent.tools.policy') return desktopAgentToolPolicy()
        if (method.endsWith('.available')) return false
        if (method === 'agent.log.append') return null
        if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
        if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
        if (method === 'agent.memory.resolveEmbedding') return null
        throw new Error('未预期的反思宿主请求')
      })
      await host.request('agent.memory.resumeReflections')
      await vi.waitFor(async () => {
        await expect(host.request('agent.memory.read')).resolves.toMatchObject({ text: expect.stringContaining('偏好使用合成日程模板') })
      }, { timeout: 3500 })
      expect(providerRequests).toHaveLength(1)
      expect(providerRequests[0]).toContain('合成用户偏好 1')
      const session = await host.request<{ id: number }>('agent.sessions.create', { title: '召回记忆' })
      const run = await host.request<{ run_id: string }>('agent.sessions.startRun', {
        id: session.id, text: '我平时用什么模板？', clientId: randomUUID(), model: config,
      })
      await vi.waitFor(async () => {
        await expect(host.request('agent.sessions.events', { id: session.id, runId: run.run_id, stateOnly: true }))
          .resolves.toMatchObject({ status: 'completed' })
      }, { timeout: 3500 })
      expect(chatRequests[0]).toContain('偏好使用合成日程模板')

      const query = '偏好使用合成日程模板'
      const { revision, count } = await host.request<{ revision: string; count: number }>('agent.memory.forget', { query })
      expect(count).toBe(1)
      await expect(host.request('agent.memory.forget', { query, revision })).resolves.toMatchObject({ count: 1 })
      await host.request('agent.sessions.startRun', {
        id: session.id, text: '我平时用什么模板？', clientId: randomUUID(), model: config,
      })
      await vi.waitFor(() => expect(chatRequests).toHaveLength(2), { timeout: 3500 })
      expect(chatRequests[1]).not.toContain(query)
    } finally { await host.close() }
    const saved = new DatabaseSync(database, { readOnly: true })
    try {
      expect(saved.prepare('SELECT status,attempts FROM desktop_agent_reflection_jobs WHERE session_id IN (?,?) ORDER BY attempts').all(...contracts.map(item => item.sessionId))).toEqual([
        { status: 'completed', attempts: 2 }, { status: 'failed', attempts: 3 },
      ])
    } finally { saved.close() }
  }, 12_000)

  it('桌面整理会话时可重连进度，保留近期消息并允许读取其他会话', async () => {
    const database = join(directory(), 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, database)
    let release!: () => void
    let gate = new Promise<void>(resolve => { release = resolve })
    const providerStarted = vi.fn()
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        providerStarted()
        void gate.then(() => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ choices: [{ message: { content: '合成历史摘要' }, finish_reason: 'stop' }] }))
        })
      })
    })
    try {
      await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('模拟模型端口未就绪')
      const model = { provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`,
        model: 'synthetic', context_tokens: 256000, max_tokens: 2000 }
      const handlers = agentSessionHandlers(host, {
        resolveRunModel: async () => model,
      } as unknown as ReturnType<typeof createDesktopAgentModelService>)
      const command = handlers[DESKTOP_CHANNELS.agentSessions]!
      const { id } = await host.request<{ id: number }>('agent.sessions.create', { title: '合成摘要会话' })
      const empty = await host.request<{ id: number }>('agent.sessions.create', { title: '合成空会话' })
      await expect(command({ action: 'send', text: '/compact', id: empty.id, operationId: randomUUID() })).resolves.toEqual([
        expect.objectContaining({ role: 'user', text: '/compact' }),
        expect.objectContaining({ role: 'assistant', text: '当前历史还不够长，暂时无需整理上下文。' }),
      ])
      expect(providerStarted).not.toHaveBeenCalled()
      for (let index = 0; index < 12; index++) {
        await host.request('agent.sessions.append', { id, text: `合成问题 ${index}`, reply: `合成回答 ${index}` })
      }
      const request = { action: 'send', text: '/compact', id, stream: true, operationId: randomUUID() }
      const events: DesktopAgentChatEvent[] = []
      const pending = command(request, (event: DesktopAgentChatEvent) => events.push(event))
      await vi.waitFor(() => expect(providerStarted).toHaveBeenCalled(), { timeout: 2500 })
      expect(events).toEqual([expect.objectContaining({ type: 'projected',
        event: { type: '_context_compaction', phase: 'started', reason: 'manual_compact' } })])
      await expect(host.request('agent.sessions.history', { id: empty.id })).resolves.toMatchObject({
        messages: [expect.objectContaining({ text: '/compact' }), expect.objectContaining({ role: 'assistant' })],
      })
      const state = await host.request<DesktopAgentEventPage>('agent.sessions.events', { id, stateOnly: true })
      expect(state).toMatchObject({ runId: expect.any(String), status: 'running', executionState: 'baseline_updating' })
      await expect(host.request('agent.sessions.list')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id, isRunning: true }),
      ]))
      const resumedEvents: DesktopAgentChatEvent[] = []
      const resumed = command({ action: 'resume', id, runId: state.runId, operationId: randomUUID() },
        (event: DesktopAgentChatEvent) => resumedEvents.push(event))
      await vi.waitFor(() => expect(resumedEvents[0]).toMatchObject({ type: 'projected',
        event: { type: '_context_compaction', phase: 'started' } }))
      release()
      const expected = '上下文已经整理好了，旧对话已压缩为摘要。'
      const persisted = expect.arrayContaining([
        expect.objectContaining({ text: '合成回答 11' }),
        expect.objectContaining({ text: '/compact', clientMessageId: request.operationId }),
        expect.objectContaining({ text: expected }),
      ])
      await expect(pending).resolves.toEqual(persisted)
      await expect(resumed).resolves.toEqual(persisted)
      expect(resumedEvents).toContainEqual(expect.objectContaining({ type: 'content', text: expected }))
      expect(events.slice(1)).toEqual([
        expect.objectContaining({ type: 'session_id', session_id: id, user_message_id: expect.any(Number) }),
        expect.objectContaining({ type: 'projected', event: { type: '_context_compaction', phase: 'completed', reason: 'manual_compact' } }),
        expect.objectContaining({ type: 'content', text: expected }),
        expect.objectContaining({ type: 'projected', event: { type: 'done' } }),
      ])
      await expect(command(request)).resolves.toEqual(persisted)
      expect(providerStarted).toHaveBeenCalledTimes(1)
      await expect(host.request('agent.sessions.messages', { id })).resolves.toEqual(persisted)
      const cancelled = await host.request<{ id: number }>('agent.sessions.create', { title: '合成取消会话' })
      for (let index = 0; index < 12; index++)
        await host.request('agent.sessions.append', { id: cancelled.id, text: `合成问题 ${index}`, reply: `合成回答 ${index}` })
      gate = new Promise<void>(resolve => { release = resolve })
      const stopped = command({ ...request, id: cancelled.id, operationId: randomUUID() })
      const stopCheck = expect(stopped).rejects.toMatchObject({ code: 'cancelled' })
      await vi.waitFor(() => expect(providerStarted).toHaveBeenCalledTimes(2))
      const active = await host.request<DesktopAgentEventPage>('agent.sessions.events', { id: cancelled.id, stateOnly: true })
      await expect(host.request('agent.sessions.cancelRun', { id: cancelled.id, runId: active.runId }))
        .resolves.toEqual({ ok: true, outcome: 'requested' })
      await stopCheck
      await expect(host.request('agent.sessions.events', { id: cancelled.id, stateOnly: true }))
        .resolves.toMatchObject({ status: 'idle' })
      const cancellationHistory = await host.request<Array<{ text: string }>>('agent.sessions.messages', { id: cancelled.id })
      expect(cancellationHistory.some(message => message.text === '/compact')).toBe(false)
      release()
      await host.close()
      const db = new DatabaseSync(database, { readOnly: true })
      try {
        const summary = db.prepare("SELECT content, covers_until_seq FROM conversation_messages WHERE session_id=? AND role='summary'").get(id)
        expect(summary?.content).toContain('合成历史摘要')
        expect(summary?.covers_until_seq).toBeGreaterThan(0)
        expect(summary?.covers_until_seq).toBeLessThan(24)
      } finally { db.close() }
    } finally {
      release()
      await host.close()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
  }, 15_000)

  it('桌面会话问答同事务写入 SQLite，重放后只有一组消息', async () => {
    const database = join(directory(), 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule })
    await runtime.close()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, database)
    try {
      const { id } = await host.request<{ id: number }>('agent.sessions.create', { title: '合成对话' }, randomUUID())
      const attachId = randomUUID().replaceAll('-', '')
      await host.request('agent.attachments.stage', { attachment: {
        attachId, name: '合成文件', ext: 'txt', mime: 'text/plain', size: 3, voice: false,
      } })
      await expect(host.request('agent.attachments.forSession', { id })).resolves.toEqual([])
      await expect(host.request('agent.attachments.download', { attach_id: attachId })).rejects.toMatchObject({ code: 'not_found' })
      await expect(host.request('agent.attachments.deleteDraft', { attach_id: attachId }))
        .resolves.toBe(`agent-attachments/${attachId}`)
      const params = { id, text: '合成提问', reply: '合成回复' }
      const operation = randomUUID()
      await host.request('agent.sessions.append', params, operation)
      await host.request('agent.sessions.append', params, operation)
      expect(await host.request('agent.sessions.messages', { id })).toEqual([
        expect.objectContaining({ role: 'user', text: '合成提问' }),
        expect.objectContaining({ role: 'assistant', text: '合成回复' }),
      ])
      for (let i = 2; i <= 11; i++)
        await host.request('agent.sessions.append', { id, text: `合成提问 ${i}`, reply: `合成回复 ${i}` }, randomUUID())
      const latest = await host.request<import('@gugu/core/desktop').DesktopAgentHistoryPage>('agent.sessions.history', { id })
      expect(latest.messages).toHaveLength(20)
      expect(latest.messages[0]?.text).toBe('合成提问 2')
      expect(latest.pagination.hasMore).toBe(true)
      const older = await host.request<import('@gugu/core/desktop').DesktopAgentHistoryPage>('agent.sessions.history', {
        id, before: latest.pagination.oldestId,
      })
      expect(older.messages.map(message => message.text)).toEqual(['合成提问', '合成回复'])
      expect(older.pagination.hasMore).toBe(false)
    } finally { await host.close() }
  })

  it('通过桌面会话命令改名、删除和重放，重启后只保留未删除的会话', async () => {
    const database = join(directory(), 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule })
    await runtime.close()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    try {
      const kept = await host.request<{ id: number }>('agent.sessions.create', { title: '旧标题' }, randomUUID())
      const removed = await host.request<{ id: number }>('agent.sessions.create', { title: '待删除会话' }, randomUUID())
      await host.request('agent.sessions.append', { id: removed.id, text: '合成问题', reply: '合成回答' }, randomUUID())
      const { messages } = await host.request<import('@gugu/core/desktop').DesktopAgentHistoryPage>('agent.sessions.history', { id: removed.id })
      const messageId = messages[0]!.id
      const handler = agentSessionHandlers(host, {} as ReturnType<typeof createDesktopAgentModelService>)[DESKTOP_CHANNELS.agentSessions]!
      await expect(handler({ action: 'messageLocation', messageId })).resolves.toEqual({ id: messageId, sessionId: removed.id })
      await expect(host.request('agent.sessions.rename', { id: kept.id, title: '   ' }, randomUUID())).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(host.request('agent.sessions.rename', { id: kept.id, title: ' 新标题 ' }, randomUUID()))
        .resolves.toMatchObject({ id: kept.id, title: '新标题' })
      const operationId = randomUUID()
      await expect(host.request('agent.sessions.delete', { id: removed.id }, operationId)).resolves.toBeNull()
      await expect(host.request('agent.sessions.delete', { id: removed.id }, operationId)).resolves.toBeNull()
      await host.close()
      host = await launchCoreHost(process.execPath, entry, database)
      await expect(host.request('agent.sessions.list', {})).resolves.toEqual([expect.objectContaining({ id: kept.id, title: '新标题' })])
      await expect(host.request('agent.sessions.history', { id: removed.id })).rejects.toMatchObject({ code: 'not_found' })
      await expect(host.request('agent.sessions.messageLocation', { messageId })).rejects.toMatchObject({ code: 'not_found' })
      await host.close()
      const db = new DatabaseSync(database, { readOnly: true })
      try {
        expect(db.prepare('SELECT title_locked FROM conversation_sessions WHERE id=?').get(kept.id)).toMatchObject({ title_locked: 1 })
        expect(db.prepare('SELECT count(*) AS count FROM conversation_messages WHERE session_id=?').get(removed.id)).toMatchObject({ count: 0 })
      } finally { db.close() }
    } finally { await host.close() }
  })

  it('联系人重命名经具名 IPC 写入正式 SQLite 并在重启后保留', async () => {
    const root = directory(), database = join(root, 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule })
    await runtime.close()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      const client = await handlers['gugu:clients:create']!('旧联系人') as { id: number }
      expect(await handlers['gugu:clients:rename']!(client.id, '新联系人')).toMatchObject({ id: client.id, name: '新联系人' })
      await expect(handlers['gugu:clients:rename']!(client.id, '  ')).rejects.toMatchObject({ code: 'invalid_request' })
    } finally { await host.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try { expect(await workspaceHandlers(host, async () => null)['gugu:clients:list']!()).toEqual(expect.arrayContaining([expect.objectContaining({ name: '新联系人' })])) }
    finally { await host.close() }
  })
  it('联系人经具名 IPC 删除后不再出现在 SQLite 列表中，且重启后仍已删除', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    let client: { id: number }
    try {
      const handlers = workspaceHandlers(host, async () => null)
      client = await handlers['gugu:clients:create']!('待删除联系人') as typeof client
      await handlers['gugu:clients:delete']!(client.id)
      expect(await handlers['gugu:clients:list']!()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: client.id })]))
    } finally { await host.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      expect(await workspaceHandlers(host, async () => null)['gugu:clients:list']!()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: client!.id })]))
    } finally { await host.close() }
  })
  it('项目重命名经具名 IPC 写入正式 SQLite 并在重启后保留', async () => {
    const root = directory(), database = join(root, 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule })
    await runtime.close()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      const project = await handlers['gugu:projects:create']!('原项目') as { id: number; version: number }
      const updated = await handlers['gugu:projects:rename']!(project.id, project.version, '新项目') as { version: number }
      expect(updated.version).toBe(project.version + 1)
      await expect(handlers['gugu:projects:rename']!(project.id, project.version, '旧版本')).rejects.toMatchObject({ code: 'conflict' })
    } finally { await host.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try { expect(await workspaceHandlers(host, async () => null)['gugu:projects:list']!()).toEqual(expect.arrayContaining([expect.objectContaining({ name: '新项目', version: 2 })])) }
    finally { await host.close() }
  })
  it('项目看板经具名 IPC 持久化阶段、版本、归档和回收站恢复', async () => {
    const database = join(directory(), 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule })
    await runtime.close()
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    let projectId = 0
    try {
      const ipc = workspaceHandlers(host, async () => null)
      const operationId = randomUUID()
      const fields = {
        name: '本地项目',
        client: '小北',
        status: 'active',
        startDate: '2026-11-18',
        currentStage: 's0',
        stages: [{ key: 's0', label: '制作', todos: [{ id: 't1', text: '整理', done: false }] }],
      }
      const project = await ipc['gugu:projects:board:create']!(fields, operationId) as { id: number; version: number }
      projectId = project.id
      expect(await ipc['gugu:projects:board:create']!(fields, operationId)).toEqual(project)
      expect(await ipc['gugu:projects:board:list']!('active', 0)).toMatchObject({
        items: [{ ...fields, id: projectId, version: project.version }], nextOffset: null,
      })
      await expect(ipc['gugu:projects:board:update']!(projectId, project.version, {
        status: 'done', progress: 100,
      })).resolves.toMatchObject({ status: 'done', progress: 100, version: project.version + 1 })
      await expect(ipc['gugu:projects:board:update']!(projectId, project.version, { name: '旧版本' }))
        .rejects.toMatchObject({ code: 'conflict' })
      await expect(ipc['gugu:projects:board:update']!(projectId, project.version + 1, { archived: true }))
        .resolves.toMatchObject({ archived: true, version: project.version + 2 })
      expect(await ipc['gugu:projects:board:list']!('active', 0)).toMatchObject({ items: [] })
      expect(await ipc['gugu:projects:board:list']!('archived', 0)).toMatchObject({ items: [{ id: projectId }] })
      const event = await ipc['gugu:calendar:create']!('关联活动', '2026-11-18') as { id: number; version: number }
      await ipc['gugu:calendar:update']!(event.id, { version: event.version, projectId })
      await ipc['gugu:projects:board:delete']!(projectId)
      expect(await ipc['gugu:projects:board:list']!('archived', 0)).toMatchObject({ items: [] })
      await expect(ipc['gugu:projects:board:get']!(projectId)).rejects.toMatchObject({ code: 'not_found' })
      expect(await ipc['gugu:calendar:list']!()).toEqual([])
    } finally { await host.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      const ipc = workspaceHandlers(host, async () => null)
      expect(await ipc['gugu:projects:board:list']!('deleted', 0)).toMatchObject({
        items: [{ id: projectId, deletedAt: expect.any(String) }],
      })
      const restored = await ipc['gugu:projects:board:restore']!(projectId) as { version: number }
      expect(restored).toMatchObject({ id: projectId, archived: true, deletedAt: null, status: 'done' })
      expect(await ipc['gugu:calendar:list']!()).toMatchObject([{ title: '关联活动', projectId }])
      await ipc['gugu:projects:board:update']!(projectId, restored.version, { archived: false })
      expect(await ipc['gugu:projects:board:list']!('active', 0)).toMatchObject({ items: [{ id: projectId, archived: false }] })
      expect(await ipc['gugu:projects:board:list']!('deleted', 0)).toMatchObject({ items: [] })
    } finally { await host.close() }
  })
  it('日历经具名 IPC 编辑、软删除、Undo/Redo 并通过正式 SQLite 持久化', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const start = async () => {
      const lifecycle = new DesktopLifecycle(() => launchCoreHost(process.execPath, entry, database))
      await lifecycle.start()
      return lifecycle
    }
    let host = await start()
    let event: { id: number; title: string; date: string; version: number }
    try {
      const handlers = workspaceHandlers(host, async () => null)
      const details = { time: '09:30', endTime: '10:45', description: '合成说明' }
      event = await handlers['gugu:calendar:create']!('桌面日历回归', '2026-11-16', details) as typeof event
      expect(event).toMatchObject({ title: '桌面日历回归', date: '2026-11-16', version: 1, ...details })
      event = await handlers['gugu:calendar:update']!(event.id, {
        version: event.version, title: '更新的桌面日程', date: '2026-11-17', time: null, endTime: null,
      }) as typeof event
      expect(event).toMatchObject({ title: '更新的桌面日程', date: '2026-11-17', version: 2, time: null, endTime: null, description: details.description })
      await expect(handlers['gugu:calendar:update']!(event.id, { version: 1, title: '旧版本' })).rejects.toMatchObject({ code: 'conflict' })
      await handlers['gugu:calendar:delete']!(event.id, event.version)
      expect(await handlers['gugu:calendar:list']!()).toEqual([])
      const preview = await handlers['gugu:undo:preview']!('desktop-calendar') as { undo: { operation_id: string; can_undo: boolean } }
      expect(preview.undo).toMatchObject({ can_undo: true })
    } finally { await host.close() }
    host = await start()
    try {
      const handlers = workspaceHandlers(host, async () => null)
      const undo = await handlers['gugu:undo:preview']!('desktop-calendar') as { undo: { operation_id: string } }
      const requestId = randomUUID()
      await handlers['gugu:undo:apply']!('desktop-calendar', undo.undo.operation_id, requestId)
      expect(await handlers['gugu:operations:get']!(requestId)).toMatchObject({ method: 'undo.apply' })
      const events = await handlers['gugu:calendar:list']!() as typeof event[]
      event = events[0]!
      expect(event).toMatchObject({ title: '更新的桌面日程', date: '2026-11-17', version: 4, time: null, endTime: null, description: '合成说明' })
      const preview = await handlers['gugu:undo:preview']!('desktop-calendar') as { redo: { operation_id: string; can_redo: boolean } }
      expect(preview.redo).toMatchObject({ can_redo: true })
      await handlers['gugu:undo:redo']!('desktop-calendar', preview.redo.operation_id, randomUUID())
      expect(await handlers['gugu:calendar:list']!()).toEqual([])
    } finally { await host.close() }
    const databaseView = new DatabaseSync(database)
    try {
      expect(databaseView.prepare("SELECT operation FROM rag_index_jobs WHERE source_type='calendar' AND source_id=?").get(String(event!.id))).toMatchObject({ operation: 'delete' })
    } finally { databaseView.close() }
  })
  it('便签经具名 IPC 创建、版本更新和软删除，均写入正式 SQLite 并在重启后保留', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    let note: { id: number; contentMd: string; version: number }
    try {
      const handlers = workspaceHandlers(host, async () => null)
      note = await handlers['gugu:mind:notes:create']!('# 桌面便签\n\n正文') as typeof note
      expect(note).toMatchObject({ contentMd: '# 桌面便签\n\n正文', version: 1 })
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([note])
      note = await handlers['gugu:mind:notes:update']!(note.id, { version: note.version, contentMd: '# 桌面便签\n\n更新正文' }) as typeof note
      expect(note).toMatchObject({ contentMd: '# 桌面便签\n\n更新正文', version: 2 })
      await expect(handlers['gugu:mind:notes:update']!(note.id, { version: 1, contentMd: '过期版本' })).rejects.toMatchObject({ code: 'conflict' })
    } finally { await host.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([note!])
      await handlers['gugu:mind:notes:delete']!(note!.id)
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([])
      const preview = await handlers['gugu:undo:preview']!('desktop-mind') as { undo: { operation_id: string; can_undo: boolean } }
      expect(preview.undo).toMatchObject({ can_undo: true })
      await handlers['gugu:undo:apply']!('desktop-mind', preview.undo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:notes:list']!()).toEqual([
        expect.objectContaining({ id: note!.id, contentMd: '# 桌面便签\n\n更新正文', version: 4 }),
      ])
    }
    finally { await host.close() }
  })
  it('画布经具名 IPC 创建、改名、软删除及 Undo/Redo 持久化到正式 SQLite', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    let canvas: { id: number; title: string }
    try {
      const handlers = workspaceHandlers(host, async () => null)
      canvas = await handlers['gugu:mind:canvases:create']!('桌面画布') as typeof canvas
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([expect.objectContaining({ id: canvas.id, title: '桌面画布' })])
      canvas = await handlers['gugu:mind:canvases:update']!(canvas.id, { title: '更新的桌面画布' }) as typeof canvas
      expect(canvas.title).toBe('更新的桌面画布')
      await handlers['gugu:mind:canvases:delete']!(canvas.id)
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([])
    } finally { await host.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      const undo = await handlers['gugu:undo:preview']!('desktop-mind') as { undo: { operation_id: string; can_undo: boolean } }
      expect(undo.undo).toMatchObject({ can_undo: true })
      await handlers['gugu:undo:apply']!('desktop-mind', undo.undo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([expect.objectContaining({ id: canvas!.id, title: '更新的桌面画布' })])
      const redo = await handlers['gugu:undo:preview']!('desktop-mind') as { redo: { operation_id: string; can_redo: boolean } }
      expect(redo.redo).toMatchObject({ can_redo: true })
      await handlers['gugu:undo:redo']!('desktop-mind', redo.redo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:list']!()).toEqual([])
    } finally { await host.close() }
    const databaseView = new DatabaseSync(database)
    try {
      expect(databaseView.prepare('SELECT deleted_at FROM mind_maps WHERE id=?').get(canvas!.id)).toMatchObject({ deleted_at: expect.any(String) })
    } finally { databaseView.close() }
  })
  it('桌面代理、网关保活与外观偏好独立保存并在重启后恢复', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const workbench = { locale: 'ja-JP', defaultView: 'calendar', calendarWeekStart: 'sunday', calendarDoneMode: 'deadline', projectSort: 'name' }
    let host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      expect(await handlers['gugu:preferences:appearance:get']!()).toEqual({
        theme: 'light', themeFamily: 'glass', palette: 'neutral', useSystemProxy: false, keepGatewayOnline: true,
        timezone: null, locale: null, defaultView: 'projects', calendarWeekStart: 'monday', calendarDoneMode: 'done', projectSort: 'default',
        imToolDisplayMode: 'all', showIntermediateReplies: false, decisionGuardEnabled: false, toolInjectionMode: 'description', customReplyStyle: null, customReplyStyleEnabled: false,
      })
    } finally { await host.close() }
    const databaseView = new DatabaseSync(database)
    try {
      const owner = databaseView.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").get() as { value: string }
      databaseView.prepare('INSERT INTO user_preferences (user_id,data_json,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').run(owner.value.replaceAll('-', ''), JSON.stringify({ custom_reply_style: '保留的旧文本偏好', automatic_mode_enabled: true, shellFullAccess: true }))
    } finally { databaseView.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      await expect(handlers['gugu:preferences:appearance:update']!({ useSystemProxy: 'true' })).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await handlers['gugu:preferences:appearance:update']!({ useSystemProxy: true })).toMatchObject({ useSystemProxy: true, theme: 'light' })
      expect(await handlers['gugu:preferences:appearance:update']!({ automaticModeEnabled: false })).toMatchObject({ useSystemProxy: true, automaticModeEnabled: false })
      expect(await handlers['gugu:preferences:appearance:update']!({ automaticModeEnabled: true })).toMatchObject({ useSystemProxy: true, automaticModeEnabled: true })
      await expect(handlers['gugu:preferences:appearance:update']!({ shellFullAccess: true })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(handlers['gugu:preferences:appearance:update']!({ keepGatewayOnline: 'false' })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(handlers['gugu:preferences:appearance:update']!({ keepGatewayOnline: false })).resolves.toMatchObject({ keepGatewayOnline: false })
      await expect(handlers['gugu:preferences:appearance:update']!({ timezone: 'Invalid/Timezone' }))
        .rejects.toMatchObject({ code: 'invalid_request' })
      await expect(handlers['gugu:preferences:appearance:update']!({ timezone: 'Pacific/Kiritimati' }))
        .resolves.toMatchObject({ timezone: 'Pacific/Kiritimati' })
      await expect(handlers['gugu:preferences:appearance:update']!({ projectSort: 'invalid' })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(handlers['gugu:preferences:appearance:update']!({ defaultView: ['calendar'] })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(handlers['gugu:preferences:appearance:update']!(workbench)).resolves.toMatchObject(workbench)
      expect(await handlers['gugu:preferences:appearance:update']!({ theme: 'dark', themeFamily: 'mono', palette: 'cafe' })).toEqual({
        theme: 'dark', themeFamily: 'mono', palette: 'cafe', useSystemProxy: true, automaticModeEnabled: true, keepGatewayOnline: false,
        timezone: 'Pacific/Kiritimati', ...workbench,
        imToolDisplayMode: 'all', showIntermediateReplies: false, decisionGuardEnabled: false, toolInjectionMode: 'description', customReplyStyle: '保留的旧文本偏好', customReplyStyleEnabled: false,
      })
      await expect(handlers['gugu:preferences:appearance:update']!({ smtpPassword: '不允许' })).rejects.toMatchObject({ code: 'invalid_request' })
    } finally { await host.close() }
    const persistedView = new DatabaseSync(database)
    try {
      const row = persistedView.prepare('SELECT data_json FROM user_preferences').get() as { data_json: string }
      expect(JSON.parse(row.data_json)).toMatchObject({ theme: 'dark', theme_family: 'mono', palette: 'cafe', custom_reply_style: '保留的旧文本偏好', automatic_mode_enabled: true })
    } finally { persistedView.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      expect(await workspaceHandlers(host, async () => null)['gugu:preferences:appearance:get']!()).toEqual({
        theme: 'dark', themeFamily: 'mono', palette: 'cafe', useSystemProxy: true, automaticModeEnabled: true, keepGatewayOnline: false,
        timezone: 'Pacific/Kiritimati', ...workbench,
        imToolDisplayMode: 'all', showIntermediateReplies: false, decisionGuardEnabled: false, toolInjectionMode: 'description', customReplyStyle: '保留的旧文本偏好', customReplyStyleEnabled: false,
      })
      const patch = workspaceHandlers(host, async () => null)['gugu:preferences:appearance:update']!
      const maxStyle = '🌕'.repeat(10_000)
      await expect(patch({ customReplyStyle: maxStyle })).resolves.toMatchObject({ customReplyStyle: maxStyle })
      await expect(patch({ customReplyStyle: maxStyle + '月' })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(patch({ customReplyStyle: null, timezone: null }))
        .resolves.toMatchObject({ timezone: null, customReplyStyle: null })
    } finally { await host.close() }
  })
  it('引导状态经具名 IPC 从正式 SQLite 读取，并按 owner 当前状态计算展示条件', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    try {
      expect(await workspaceHandlers(host, async () => null)['gugu:onboarding:state:get']!()).toMatchObject({ should_show: false, guide: { enabled: false } })
    } finally { await host.close() }
    const databaseView = new DatabaseSync(database)
    try {
      const owner = databaseView.prepare("SELECT value FROM core_runtime_meta WHERE key='owner_id'").get() as { value: string }
      const state = { seed: { seeded: true, project_id: 6, project_name: '本地项目' }, guide: { enabled: true, version: 1, current_step: 'style', completed_steps: ['locale'], dismissed: false, completed_at: null } }
      databaseView.prepare('UPDATE onboarding_state SET state=? WHERE user_id=?').run(JSON.stringify(state), owner.value.replaceAll('-', ''))
    } finally { databaseView.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      expect(await workspaceHandlers(host, async () => null)['gugu:onboarding:state:get']!()).toMatchObject({
        should_show: true,
        seed: { seeded: true, project_id: 6 },
        guide: { enabled: true, current_step: 'style', completed_steps: ['locale'], should_show: true },
      })
    } finally { await host.close() }
  })
  it('画布便签经具名 IPC 创建、编辑、定位、移除并通过 SQLite 与 Undo/Redo 持久化', async () => {
    const root = directory(), database = join(root, 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    let host = await launchCoreHost(process.execPath, entry, database)
    let canvas: { id: number }
    let item: { id: number; nodeId: number; x: number; y: number; node: { id: number; kind: string; contentMd: string; version: number } }
    try {
      const handlers = workspaceHandlers(host, async () => null)
      canvas = await handlers['gugu:mind:canvases:create']!('可编辑画布') as typeof canvas
      item = await handlers['gugu:mind:canvases:notes:create']!(canvas.id, { contentMd: '# 画布便签\n\n初始正文', color: 'amber', x: 12, y: 34 }) as typeof item
      expect(item).toMatchObject({ canvasId: canvas.id, x: 12, y: 34, node: { kind: 'canvas_note', contentMd: '# 画布便签\n\n初始正文', version: 1 } })
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas.id)).toEqual([expect.objectContaining({ id: item.id, nodeId: item.nodeId })])
      await handlers['gugu:mind:canvases:notes:update']!(item.nodeId, { version: 1, contentMd: '# 画布便签\n\n更新正文' })
      await expect(handlers['gugu:mind:canvases:notes:update']!(item.nodeId, { version: 1, contentMd: '过期版本' })).rejects.toMatchObject({ code: 'conflict' })
      item = await handlers['gugu:mind:canvases:items:update']!(canvas.id, item.id, { x: 90, y: 120 }) as typeof item
      expect(item).toMatchObject({ x: 90, y: 120 })
      await handlers['gugu:mind:canvases:items:delete']!(canvas.id, item.id)
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas.id)).toEqual([])
    } finally { await host.close() }
    host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      const undo = await handlers['gugu:undo:preview']!('desktop-mind') as { undo: { operation_id: string; can_undo: boolean } }
      expect(undo.undo.can_undo).toBe(true)
      await handlers['gugu:undo:apply']!('desktop-mind', undo.undo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas!.id)).toEqual([
        expect.objectContaining({ id: item!.id, x: 90, y: 120, node: expect.objectContaining({ contentMd: '# 画布便签\n\n更新正文', version: 2 }) }),
      ])
      const redo = await handlers['gugu:undo:preview']!('desktop-mind') as { redo: { operation_id: string; can_redo: boolean } }
      expect(redo.redo.can_redo).toBe(true)
      await handlers['gugu:undo:redo']!('desktop-mind', redo.redo.operation_id, randomUUID())
      expect(await handlers['gugu:mind:canvases:items:list']!(canvas!.id)).toEqual([])
    } finally { await host.close() }
  })
  it('拒绝旧 schema 的 Core 握手', async () => {
    const root = directory(), entry = join(root, 'old.mjs')
    writeFileSync(entry, `process.stdout.write(JSON.stringify({v:2,event:'ready',schema:'5',capabilities:['operation_receipts']})+'\\n')`)
    await expect(launchCoreHost(process.execPath, entry, join(root, 'core.db'))).rejects.toMatchObject({ code: 'startup_failed' })
  })
  it('第二个 Host 拒绝打开同一数据库，原 Host 仍可写入且释放后可重新接管', async () => {
    const root = directory(),
      database = join(root, 'core.db'),
      entry = resolve(
        import.meta.dirname,
        '../../../packages/core/dist/runtime/transport/stdio.js',
      )
    const first = await launchCoreHost(process.execPath, entry, database)
    let unexpected: CoreHost | undefined
    try {
      await first.request('projects.create', { name: '接管前计划' })
      await expect(
        launchCoreHost(process.execPath, entry, database).then((host) => {
          unexpected = host
          return host
        }),
      ).rejects.toMatchObject({ code: 'database_in_use' })
      await first.request('clients.create', { name: '拒绝第二实例后仍可写入' })
      expect(await first.request('projects.list')).toMatchObject([{ name: '接管前计划' }])
    } finally {
      await unexpected?.close()
      await first.close()
    }
    const reopened = await launchCoreHost(process.execPath, entry, database)
    try {
      expect(await reopened.request('projects.list')).toMatchObject([
        { name: '接管前计划' },
      ])
      expect(await reopened.request('clients.list')).toMatchObject([
        { name: '拒绝第二实例后仍可写入' },
      ])
    } finally {
      await reopened.close()
    }
  })
  it('Core 重启后回答原交互，并把 Anthropic 签名和工具回执交还原模型', async () => {
    const database = join(directory(), 'core.db')
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const thinking = { type: 'thinking', thinking: '合成私有推理', signature: 'synthetic-anthropic-signature' }
    const question = { type: 'tool_use', id: 'toolu_restart_question', name: 'ask_user',
      input: { kind: 'question', title: '确认称呼', body: '请提供称呼' } }
    const answer = '请称呼我小北'
    const finalText = '已收到称呼并继续'
    type Block = Record<string, unknown>
    type Message = { role: string; content: string | Block[] }
    const requests: { messages: Message[]; system: unknown }[] = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean; messages: Message[]; system: unknown }
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }))
        return
      }
      requests.push(body)
      const first = requests.length === 1
      const content = first ? [thinking, question] : [{ type: 'text', text: finalText }]
      const events = [
        { type: 'message_start', message: { content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
        ...content.flatMap((block, index) => [
          { type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index },
        ]),
        { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
    const model = {
      provider: 'local', api_format: 'anthropic', base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: '', model: 'synthetic', context_tokens: 256_000, max_tokens: 4096,
    } as const
    const modelId = 'synthetic-anthropic-model'
    async function launch() {
      const host = await launchCoreHost(process.execPath, entry, database)
      host.setHostRequestHandler(async ({ method }) => {
        if (method === 'agent.tools.policy') return desktopAgentToolPolicy()
        if (method.endsWith('.available')) return false
        if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
        if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
        if (method === 'agent.log.append') return null
        if (method === 'agent.memory.resolveEmbedding') return null
        if (method === 'agent.memory.resolveReflectionModel') return model
        throw new Error('未预期的合成宿主请求')
      })
      const sessions = agentSessionHandlers(host, {
        resolveRunModel: async () => model,
        resolveRunModelSelection: async () => ({ id: modelId, config: model }),
      } as ReturnType<typeof createDesktopAgentModelService>)[DESKTOP_CHANNELS.agentSessions]!
      return { host, sessions }
    }
    const before = await launch()
    const pending = await (async () => {
      try {
        const { id } = await before.host.request<{ id: number }>('agent.sessions.create', { title: '合成续接会话' })
        const events: DesktopAgentChatEvent[] = []
        await before.sessions({ action: 'send', id, text: '先问称呼', locale: 'ja-JP', stream: true, operationId: randomUUID() }, event => events.push(event))
        const runId = events.find(event => event.type === 'session_id')?.run_id
        const prompt = events.find(event => event.type === 'projected' && event.event.type === 'interaction_required')
        const promptId = prompt?.type === 'projected' ? Number(prompt.event.prompt_id) : NaN
        expect(runId).toEqual(expect.any(String))
        expect(promptId).toBeGreaterThan(0)
        await expect(before.host.request('agent.sessions.events', { id, runId, stateOnly: true }))
          .resolves.toMatchObject({ status: 'waiting' })
        expect(requests).toHaveLength(1)
        return { id, runId, promptId }
      } finally { await before.host.close() }
    })()
    const after = await launch()
    try {
      await after.host.request('agent.sessions.recoverStartup')
      await expect(after.sessions({ action: 'respond', ...pending, text: answer, operationId: randomUUID() }))
        .resolves.toMatchObject({ runId: pending.runId, awaitingText: false })
      await vi.waitFor(async () => {
        const page = await after.host.request<DesktopAgentEventPage>('agent.sessions.events', {
          id: pending.id, runId: pending.runId, after: 0,
        })
        expect(page.status).toBe('completed')
        expect(JSON.stringify(page.events)).not.toContain(thinking.signature)
      }, { timeout: 5_000 })
      expect(requests).toHaveLength(2)
      for (const request of requests) expect(JSON.stringify(request.system)).toContain('当前用户界面语言为「日本語」')
      const blocks = requests[1]!.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      expect(blocks).toEqual(expect.arrayContaining([
        thinking,
        expect.objectContaining({ type: 'tool_result', tool_use_id: question.id }),
      ]))
      expect(JSON.stringify(blocks.find(block => block.type === 'tool_result'))).toContain(answer)
      const history = await after.host.request('agent.sessions.history', { id: pending.id })
      expect(history).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ role: 'assistant', text: finalText })]) })
      expect(JSON.stringify(history)).not.toContain(thinking.signature)
      expect(JSON.stringify(history)).not.toContain(thinking.thinking)
    } finally { await after.host.close() }
  })

  it.each(['decision', 'tools', 'inflight', 'unknown'] as const)('重启后从 %s 检查点完成原运行', async phase => {
    const toolRound = phase !== 'decision'
    const inflight = phase === 'inflight' || phase === 'unknown'
    const database = join(directory(), 'core.db')
    const { initializeSqlite, openSqliteRuntime } = await import('../../../packages/core/dist/data/sqlite.js')
    const { createDesktopAgentSession } = await import('../../../packages/core/dist/agent/sessions/desktop.js')
    const { createSqliteAgentAdmission } = await import('../../../packages/core/dist/agent/run/sqlite-admission.js')
    const { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } = await import('../../../packages/core/dist/agent/run/sqlite-store.js')
    const { loadSqliteAgentRunSecret } = await import('../../../packages/core/dist/agent/run/sqlite-secret.js')
    const { MessageArea, stableJson } = await import('../../../packages/core/dist/agent/context/history/canonical-history.js')
    const { checkpointToolResult, savePreparedContext } = await import('../../../packages/core/dist/agent/context/history/attachment-refs.js')
    const { initialReplyState, emptyRunUsage } = await import('../../../packages/core/dist/agent/run/lifecycle.js')
    const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
    const text = '合成 Provider 已提交的回复'
    const call = { id: 'recovered-research', name: 'deep_research', input: { query: '合成搜索' } }
    const savedResult = { kind: 'completed' as const, successful: true, mutated: false, value: { answer: '已经保存的搜索回执' } }
    const providerRequests: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (!JSON.parse(body).stream) {
          response.end(JSON.stringify({ choices: [{ message: { content: '{}' } }] }))
          return
        }
        providerRequests.push(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成 Provider 未监听')
    const config = { provider: 'local', api_format: 'openai', base_url: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic', api_key: '' }
    const modelIdentity = digest([config.provider, config.api_format, config.base_url, config.model])
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    const identity = await (async () => {
      try {
        const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '已提交回复'))
        const { identity, userMessageId } = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
          session_id: session.id, message: '合成问题',
        })
        const area = new MessageArea({ digest, nextId: randomUUID })
        area.append({ role: 'user', content: '合成问题' }, {
          source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: String(userMessageId),
        })
        const store = createSqliteAgentRunStore(runtime.db, await loadSqliteAgentRunSecret(runtime.db, database), { async writeHistory() {} })
        const lease = (await createSqliteAgentRunLeasePort(runtime.db).acquire(identity))!
        const codec = { dehydrate: (entry: typeof area.entries[number]) => entry.message, hydrate: (entry: typeof area.entries[number]) => entry.message }
        const prepared = await savePreparedContext({ area, rag: { tail: [] }, stanceToPersist: null, protectedHistoryStart: null }, identity, codec)
        const context = { identity, modelIdentity, accessScopeHash: 'synthetic-scope', capabilities: null,
          replyContext: { userRequest: '合成问题', locale: 'zh-CN', decisionGuardEnabled: false },
          contextWindow: 256_000, providerCacheAnchor: null, continuationRef: null, compactions: [],
          failedCompactionInput: null, currentProviderInput: null, prepared,
          sourceEffects: { sessionSnapshot: { state: { ownerId, sessionId: identity.sessionId, baselineMessageSeq: 0, context: { access_scope_hash: 'synthetic-scope' } } } },
          pendingRound: toolRound ? { round: 1, text: '', calls: [call], dispatched: [], assistantEntryId: null, resultEntryId: null } : null,
        }
        const createdAt = new Date().toISOString()
        await store.create({
          identity, version: 0, sequence: 1, status: 'running', phase: toolRound ? 'tools' : 'decision', round: 1, context,
          text: phase === 'decision' ? text : '', roundTexts: phase === 'decision' ? [text] : [],
          replyState: initialReplyState, replyChoice: 'disabled', roundRequiresTools: false,
          calls: toolRound ? [call] : [], toolResults: phase === 'tools' ? [{ callId: call.id, result: await checkpointToolResult({ identity, round: 1, call }, savedResult, codec, { digest }) }] : [],
          callIndex: 0, toolsDispatched: phase === 'tools', inflightCall: inflight ? call : null,
          inflightCalls: [], serialCallIds: inflight ? [call.id] : [], parallelCallIds: [], isolatedCallIds: [], queuedInteractions: [],
          completedToolCount: 0, maxRounds: null, emptyRetries: 0,
          providerRounds: [], usage: emptyRunUsage, totalUsage: emptyRunUsage,
          displayTimeline: inflight ? [{
            kind: 'tool', eventId: 'previous-tool-event', roundId: `${identity.runId}:1`,
            runId: identity.runId, sequence: 1, timelineOrder: null, anchorMessageId: String(userMessageId),
            createdAt, updatedAt: createdAt, toolCallId: call.id, toolName: call.name, toolStatus: 'running',
          }] : [], anchorMessageId: String(userMessageId), files: [], mutated: false, goalMode: false,
        } as Parameters<typeof store.create>[0], lease, [
          inflight
            ? { id: 'previous-tool-event', identity, sequence: 1, round: 1, type: 'tool_call',
              payload: { toolCallId: call.id, name: call.name, status: 'running' } }
            : { id: 'previous-run-event', identity, sequence: 1, round: 1, type: 'run_started', payload: {} },
        ])
        return identity
      } finally { await runtime.close() }
    })()
    const host = await launchCoreHost(process.execPath,
      resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js'), database)
    const resolveModel = vi.fn(async () => config)
    const paidCalls: unknown[] = []
    host.setHostRequestHandler(async ({ method, params }) => {
      if (method === 'agent.memory.resolveReflectionModel') {
        expect(params).toEqual({ modelIdentity, modelId: null })
        return resolveModel()
      }
      if (method === 'agent.memory.resolveEmbedding') return null
      if (method === 'agent.search.deep_research.available') return phase === 'inflight'
      if (method.endsWith('.available')) return false
      if (method === 'agent.search.deep_research') {
        paidCalls.push(params)
        return phase === 'unknown' ? { kind: 'unknown' } : savedResult
      }
      if (method === 'agent.log.append') return null
      throw new Error('未预期的恢复宿主请求')
    })
    try {
      const id = Number(identity.sessionId)
      await host.request('agent.sessions.recoverStartup')
      await vi.waitFor(async () => {
        const page = await host.request<DesktopAgentEventPage>('agent.sessions.events', { id, runId: identity.runId, after: 0 })
        expect(page.status).toBe(phase === 'unknown' ? 'unknown' : 'completed')
      })
      expect(resolveModel).toHaveBeenCalledOnce()
      const hex = digest([identity.ownerId, identity.sessionId, identity.runId, `${identity.runId}:1`, call.id])
      const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
      expect(paidCalls).toEqual(inflight ? [expect.objectContaining({ operation_id: operationId, reconcile_only: true })] : [])
      const shouldContinue = toolRound && phase !== 'unknown'
      expect(providerRequests).toHaveLength(shouldContinue ? 1 : 0)
      if (shouldContinue) {
        const { messages } = JSON.parse(providerRequests[0]!) as {
          messages: Array<{ role: string; tool_call_id?: string; content: unknown }>,
        }
        const result = messages.filter(message => message.role === 'tool' && message.tool_call_id === call.id)
        expect(result).toHaveLength(1)
        expect(JSON.stringify(result[0]?.content)).toContain('已经保存的搜索回执')
      }
      if (phase !== 'unknown') expect(await host.request('agent.sessions.history', { id })).toMatchObject({ messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: '合成问题' }),
        expect.objectContaining({ role: 'assistant', text }),
      ]) })
    } finally { await host.close() }
  })

  it('启动恢复用附件摘要读取已派发的相似图收据', async () => {
    const root = directory()
    const database = join(root, 'core.db')
    const { initializeSqlite, openSqliteRuntime } = await import('../../../packages/core/dist/data/sqlite.js')
    const { createDesktopAgentSession } = await import('../../../packages/core/dist/agent/sessions/desktop.js')
    const { createDesktopChatAttachmentStore } = await import('../../../packages/core/dist/agent/attachments/desktop-store.js')
    const { createSqliteAgentAdmission } = await import('../../../packages/core/dist/agent/run/sqlite-admission.js')
    const { createSqliteAgentRunLeasePort, createSqliteAgentRunStore } = await import('../../../packages/core/dist/agent/run/sqlite-store.js')
    const { loadSqliteAgentRunSecret } = await import('../../../packages/core/dist/agent/run/sqlite-secret.js')
    const { MessageArea, stableJson } = await import('../../../packages/core/dist/agent/context/history/canonical-history.js')
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    const attachId = randomUUID().replaceAll('-', '')
    const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
    mkdirSync(join(root, 'agent-attachments'))
    writeFileSync(join(root, 'agent-attachments', attachId), bytes)
    const call = { id: 'synthetic-image', name: 'similar_image_search', input: { attach_id: attachId } }
    const session = await (async () => {
      try {
        const session = await runtime.db.transaction().execute(tx => createDesktopAgentSession(tx, ownerId, '合成重启会话'))
        await createDesktopChatAttachmentStore(runtime.db).stage(ownerId, {
          attachId, name: '合成图片', ext: 'png', mime: 'image/png', size: 8, voice: false,
        })
        const { identity, userMessageId } = await createSqliteAgentAdmission(runtime.db).prepare(ownerId, {
          session_id: session.id, message: '搜索合成图片', attachments: [attachId],
        })
        const store = createSqliteAgentRunStore(runtime.db, await loadSqliteAgentRunSecret(runtime.db, database), { async writeHistory() {} })
        const lease = (await createSqliteAgentRunLeasePort(runtime.db).acquire(identity))!
        const roundId = `${identity.runId}:1`
        const area = new MessageArea({
          digest: value => createHash('sha256').update(stableJson(value)).digest('hex'), nextId: randomUUID,
        })
        area.append({ role: 'user', content: '搜索合成图片' }, {
          source: 'user', persistencePolicy: 'already_persisted', persistedMessageId: String(userMessageId),
        })
        const createdAt = new Date().toISOString()
        await store.create({
          identity, version: 0, sequence: 1, status: 'running', phase: 'tools', round: 1,
          context: { identity, prepared: { area: area.snapshot() } }, files: [],
          inflightCall: call, inflightCalls: [],
          displayTimeline: [{ eventId: 'image-tool-card', kind: 'tool', runId: identity.runId, roundId, sequence: 1,
            timelineOrder: null, anchorMessageId: String(userMessageId), toolCallId: call.id,
            toolName: call.name, toolStatus: 'running', createdAt, updatedAt: createdAt }],
        } as Parameters<typeof store.create>[0], lease, [
          { id: 'crash-tool', identity, sequence: 1, round: 1, type: 'run_started', payload: {} },
        ])
        return { id: session.id, runId: identity.runId, roundId }
      } finally { await runtime.close() }
    })()
    const host = await launchCoreHost(process.execPath,
      resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js'), database)
    const lookup = vi.fn(async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      expect(method).toBe('agent.search.similar_image_search')
      const hash = createHash('sha256').update(JSON.stringify([ownerId, String(session.id), session.runId, session.roundId, call.id])).digest('hex')
      expect(params).toEqual({
        operation_id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        reconcile_only: true, image_digest: createHash('sha256').update(bytes).digest('hex'),
      })
      return { kind: 'completed', successful: true, mutated: false, value: { results: ['合成相似图结果'] } }
    })
    host.setHostRequestHandler(lookup)
    try {
      await host.request('agent.sessions.recoverStartup')
      await host.request('agent.sessions.recoverStartup')
      expect(lookup).toHaveBeenCalledOnce()
      const page = await host.request<DesktopAgentEventPage>('agent.sessions.events', { id: session.id, runId: session.runId, after: 0 })
      const recoveredCard = expect.objectContaining({
        toolCallId: call.id, toolStatus: 'success', toolResult: { results: ['合成相似图结果'] },
      })
      expect(page).toMatchObject({ status: 'failed', events: expect.arrayContaining([
        expect.objectContaining({ type: 'display_event', item: recoveredCard }),
        expect.objectContaining({ type: 'error', message: '上次桌面运行已中断，已恢复工具结果。' }),
        expect.objectContaining({ type: 'done', remote_status_unknown: false }),
      ]) })
      const history = await host.request<{ messages: Array<{ id: number }> }>('agent.sessions.history', { id: session.id })
      expect(history).toMatchObject({ active: false, messages: [
        expect.objectContaining({ role: 'user', text: '搜索合成图片', runOutcome: { status: 'failed', runId: session.runId } }),
        expect.objectContaining({ role: 'assistant', toolTimeline: [
          expect.objectContaining({ toolCallId: call.id, toolStatus: 'success', detailsAvailable: true }),
        ] }),
      ] })
      await expect(host.request('agent.sessions.toolDetails', { id: session.id, messageId: history.messages[1]!.id, index: 0 }))
        .resolves.toMatchObject({ toolResult: { results: ['合成相似图结果'] } })
    } finally { await host.close() }
  })

  it('实际提交后丢失回包保留操作 UUID，重启仅查询收据即可恢复且不重复写入', async () => {
    const root = directory(),
      database = join(root, 'core.db'),
      entry = join(root, 'commit-drop.mjs'),
      local = pathToFileURL(
        resolve(import.meta.dirname, '../../../packages/core/dist/runtime/local.js'),
      ).href
    writeFileSync(
      entry,
      `
      import {createInterface} from 'node:readline';
      const {LocalRuntime} = await import(${JSON.stringify(local)});
      const database = process.argv[process.argv.indexOf('--database') + 1];
      const runtime = await LocalRuntime.initialize(database, { exclusive: true, agentRuntimeModule: ${JSON.stringify(desktopAgentRuntimeModule)} });
      process.stdout.write(JSON.stringify({v:2,event:'ready',schema:'${CORE_SCHEMA_VERSION}',capabilities:['operation_receipts']})+'\\n');
      for await (const line of createInterface({input:process.stdin})) {
        const request = JSON.parse(line);
        await runtime.call(request.method, request.params, {operationId:request.operation_id});
        await runtime.close();
        process.exit(23);
      }
    `,
    )
    const host = await launchCoreHost(process.execPath, entry, database)
    let operation: string | undefined
    try {
      const failure: unknown = await host
        .request('projects.create', { name: '已提交但无回包' })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(DesktopError)
      if (!(failure instanceof DesktopError)) throw new Error('未收到可恢复的桌面错误')
      expect(failure).toMatchObject({
        code: 'unknown_result',
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      })
      operation = failure.operationId
      await expect(
        host.request('projects.create', { name: '不得自动重放' }),
      ).rejects.toMatchObject({ code: 'closed' })
    } finally {
      await host.close()
    }
    const reopened = await launchCoreHost(
      process.execPath,
      resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js'),
      database,
    )
    try {
      const receipt = await reopened.request<{ method: string; result: { name: string } }>(
        'operations.get',
        { operation_id: operation },
      )
      expect(receipt).toMatchObject({
        method: 'projects.create',
        result: { name: '已提交但无回包', version: 1 },
      })
      expect(await reopened.request('projects.list')).toEqual([
        { id: receipt.result.id, name: receipt.result.name, version: receipt.result.version },
      ])
    } finally {
      await reopened.close()
    }
  })
  it('排队请求固定调用时的参数快照，不受随后对象修改影响', async () => {
    const host = await fake('({v:2,id:request.id,result:request.params})')
    try {
      const params = { name: '原始计划' },
        result = host.request('projects.create', params)
      params.name = '不应替换'
      expect(await result).toEqual({ name: '原始计划' })
    } finally {
      await host.close()
    }
  })
  it('真实数据进程支持并发调用排队、关闭拒绝新增、重启收据和稳定身份', async () => {
    const root = directory(),
      database = join(root, 'core.db'),
      entry = resolve(
        import.meta.dirname,
        '../../../packages/core/dist/runtime/transport/stdio.js',
      )
    const host = await launchCoreHost(process.execPath, entry, database)
    const [project, contact] = await Promise.all([
      host.request<{ id: number; name: string }>('projects.create', {
        name: '本地计划',
      }),
      host.request<{ name: string }>('clients.create', { name: '小北' }),
    ])
    expect(project.name).toBe('本地计划')
    expect(contact.name).toBe('小北')
    const closes = [host.close(), host.close()]
    await expect(host.request('projects.list')).rejects.toMatchObject({
      code: 'closed',
    })
    await Promise.all(closes)
    const reopened = await launchCoreHost(process.execPath, entry, database)
    try {
      expect(await reopened.request('projects.list')).toMatchObject([
        { id: project.id, name: '本地计划' },
      ])
    } finally {
      await reopened.close()
    }
  })
  it.each([
    ['({v:2,id:request.id+1,result:{}})', true],
    ['({v:2,id:request.id})', true],
    ["({v:2,id:request.id,result:{},error:{code:'conflict'}})", true],
  ])('未知写入结果保留操作 ID，损坏协议终止 Host %#', async (response, fatal) => {
    const host = await fake(response as string)
    try {
      const error = await host
        .request('projects.create', { name: '合成项目' })
        .catch((error) => error)
      expect(error).toBeInstanceOf(DesktopError)
      expect(error.code).toBe('unknown_result')
      expect(error.operationId).toMatch(/^[0-9a-f-]{36}$/)
      expect(error.message).not.toContain('合成敏感正文')
      if (fatal)
        await expect(
          host.request('operations.get', { operation_id: error.operationId }),
        ).rejects.toMatchObject({ code: 'closed' })
      else
        expect(
          await host.request('operations.get', {
            operation_id: error.operationId,
          }),
        ).toBeNull()
    } finally {
      await host.close()
    }
  })
  it.each([
    ['busy', '本地数据队列已满，请稍后重试'],
    ['cancelled', '操作已取消'],
    ['result_too_large', '返回结果超出桌面协议限制'],
    ['storage_error', '本地数据操作失败，请刷新数据确认状态'],
  ])('Core 明确返回 %s 时保留确定失败语义', async (code, message) => {
    const host = await fake(`({v:2,id:request.id,error:{code:'${code}',message:'合成错误'}})`)
    try {
      await expect(host.request('projects.list')).rejects.toMatchObject({ code, message })
    } finally {
      await host.close()
    }
  })
  it('拒绝通用 Shell、FS 与身份覆盖，合法拒绝后仍能读取', async () => {
    const host = await fake("({v:2,id:request.id,error:{code:'invalid_request'}})")
    try {
      for (const method of ['shell.run', 'fs.read', '__proto__'])
        await expect(host.request(method)).rejects.toMatchObject({
          code: 'invalid_request',
        })
      await expect(
        host.request('projects.create', {
          name: '覆盖身份',
          owner_id: '合成身份',
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await host.request('operations.get', { operation_id: '合成操作' })).toBeNull()
    } finally {
      await host.close()
    }
  })
  it('制品必须匹配平台、ABI 元数据和全部资源摘要，拒绝越界及额外注入', async () => {
    const root = directory(),
      executable = process.platform === 'win32' ? 'node.exe' : 'node'
    const files: Record<string, string> = {}
    for (const name of [
      executable,
      'host/dist/runtime/transport/stdio.js',
      'host/dist/runtime/worker.js',
      'host/agent/runtime.mjs',
    ]) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), '合成运行资源')
      files[name] = createHash('sha256')
        .update(readFileSync(join(root, name)))
        .digest('hex')
    }
    const manifest = {
      platform: process.platform,
      arch: process.arch,
      coreVersion: '0.2.0',
      nodeVersion: process.versions.node,
      nodeAbi: process.versions.modules,
      protocol: 2,
      schema: CORE_SCHEMA_VERSION,
      executable,
      entry: 'host/dist/runtime/transport/stdio.js',
      workerEntry: 'host/dist/runtime/worker.js',
      agentRuntimeModule: 'host/agent/runtime.mjs',
      files,
    }
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    const artifact = await verifyArtifact(root)
    expect(artifact.manifest.protocol).toBe(2)
    expect(artifact.workerEntry).toBe(realpathSync(join(root, 'host/dist/runtime/worker.js')))
    expect(artifact.agentRuntimeModule).toBe(realpathSync(join(root, 'host/agent/runtime.mjs')))
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ ...manifest, schema: 5 }))
    await expect(verifyArtifact(root)).rejects.toMatchObject({ code: 'artifact_invalid' })
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(join(root, 'injected.js'), '合成额外模块')
    await expect(verifyArtifact(root)).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
    rmSync(join(root, 'injected.js'))
    writeFileSync(join(root, executable), '合成篡改')
    await expect(verifyArtifact(root)).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
    files['../outside'] = files[executable]!
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
    await expect(verifyArtifact(root)).rejects.toMatchObject({
      code: 'artifact_invalid',
    })
  })
  it('旧 v2 侧车仍可启动但没有撤销能力时拒绝 Undo', async () => {
    const host = await fake('{v:2,id:request.id,result:request}', false)
    try {
      expect(await host.request('projects.list')).toMatchObject({ method: 'projects.list' })
      await expect(host.request('undo.preview', { context_id: 'tab' })).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1' }, randomUUID())).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await host.request('operations.get', { operation_id: randomUUID() })).toBeNull()
    } finally { await host.close() }
  })
  it('具名 Undo IPC 通过真实 Core Worker 持久化撤销、重做与收据', async () => {
    const root = directory(), database = join(root, 'core.db')
    const runtime = await LocalRuntime.initialize(database, { agentRuntimeModule: desktopAgentRuntimeModule }), owner = runtime.ownerId.replaceAll('-', '')
    await runtime.close()
    const db = new DatabaseSync(database), stamp = '2026-01-01 00:00:00.000000'
    try {
      db.prepare("INSERT INTO mind_nodes (id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES (1,?,'note','本地','','','user',1,?,?,?)").run(owner, stamp, stamp, stamp)
      const snapshot = { kind: 'note', title: '本地', content_md: '', content_plain: '', color: null, captured_at: stamp, deleted_at: null }
      db.prepare("INSERT INTO undo_operations (id,user_id,undo_context_id,group_id,resource,action,target_refs,before_state,after_state,base_versions,artifact_refs,actor_type,status,created_at) VALUES ('undo-one',?,'tab','group','mind','create','[1]','{}',?,'{}','{}','web','active',?)").run(owner, JSON.stringify({ items: { 'note:1': snapshot } }), stamp)
    } finally { db.close() }
    const entry = resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js')
    const host = await launchCoreHost(process.execPath, entry, database)
    try {
      const handlers = workspaceHandlers(host, async () => null)
      expect(await handlers['gugu:undo:preview']!('tab')).toMatchObject({ available: true })
      const operationId = randomUUID()
      const first = await handlers['gugu:undo:apply']!('tab', 'undo-one', operationId) as { events: unknown[] }
      expect(first.events).toHaveLength(1)
      expect((await handlers['gugu:undo:apply']!('tab', 'undo-one', operationId) as { events: unknown[] }).events).toEqual([])
      expect(await handlers['gugu:operations:get']!(operationId)).toMatchObject({ method: 'undo.apply' })
      expect((await handlers['gugu:undo:redo']!('tab', 'undo-one', randomUUID()) as { events: unknown[] }).events).toHaveLength(1)
    } finally { await host.close() }
  })
  it('Undo 仅允许具名 v2 调用并保留调用方操作标识', async () => {
    const host = await fake('{v:2,id:request.id,result:request}')
    const operationId = 'c60f3fd0-f9bb-4237-8a38-505be6769f42'
    try {
      const preview = await host.request<Record<string, unknown>>('undo.preview', { context_id: 'tab' })
      expect(preview).toMatchObject({ v: 2, method: 'undo.preview', params: { context_id: 'tab' } })
      expect(preview).not.toHaveProperty('operation_id')
      for (const method of ['undo.apply', 'undo.redo']) {
        const result = await host.request<Record<string, unknown>>(method, { context_id: 'tab', undo_id: 'op-1' }, operationId)
        expect(result).toMatchObject({ v: 2, method, operation_id: operationId, params: { context_id: 'tab', undo_id: 'op-1' } })
        await expect(host.request(method, { context_id: 'tab', undo_id: 'op-1' })).rejects.toMatchObject({ code: 'invalid_request' })
        await expect(host.request(method, { context_id: 'tab', undo_id: 'op-1' }, 'invalid')).rejects.toMatchObject({ code: 'invalid_request' })
      }
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1', owner_id: 'foreign' }, operationId)).rejects.toMatchObject({ code: 'invalid_request' })
      await expect(host.request('undo.other', {}, operationId)).rejects.toMatchObject({ code: 'invalid_request' })
    } finally { await host.close() }
  })
  it('Undo 未知结果保留调用方操作标识供收据查询', async () => {
    const host = await fake("{v:2,id:request.id,error:{code:'synthetic_failure'}}")
    const operationId = 'c60f3fd0-f9bb-4237-8a38-505be6769f42'
    try {
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1' }, operationId)).rejects.toMatchObject({ code: 'unknown_result', operationId })
      expect(await host.request('operations.get', { operation_id: operationId })).toBeNull()
    } finally { await host.close() }
  })
  it('Undo 存储错误与通信中断保留收据标识，确定拒绝仍为业务错误', async () => {
    const operationId = 'c60f3fd0-f9bb-4237-8a38-505be6769f42'
    for (const response of ["{v:2,id:request.id,error:{code:'storage_error'}}", '{v:2,id:request.id+1,result:null}']) {
      const host = await fake(response)
      try {
        await expect(host.request('undo.redo', { context_id: 'tab', undo_id: 'op-1' }, operationId))
          .rejects.toMatchObject({ code: 'unknown_result', operationId })
      } finally { await host.close() }
    }
    const host = await fake("{v:2,id:request.id,error:{code:'not_found'}}")
    try {
      await expect(host.request('undo.apply', { context_id: 'tab', undo_id: 'op-1' }, operationId))
        .rejects.toMatchObject({ code: 'not_found', operationId: undefined })
    } finally { await host.close() }
  })
  it('未授权窗口不调用 Core，错误信封不包含原始异常', async () => {
    let called = false
    expect(
      await desktopReply(false, async () => {
        called = true
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(called).toBe(false)
    expect(
      await desktopReply(true, async () => {
        throw new Error('合成私有异常')
      }),
    ).toEqual({
      ok: false,
      error: { code: 'failed', message: '本地操作失败，请检查运行时状态' },
    })
  })

  it('工作台 IPC 只注册已声明频道，并在授权后转发 Core 结果', async () => {
    const request = vi.fn(async () => ['合成结果'])
    const handlers = workspaceHandlers({ request } as unknown as CoreHost, async () => null)
    const listeners = new Map<string, Parameters<IpcMain['handle']>[1]>()
    const handle: IpcMain['handle'] = (channel, listener) => { listeners.set(channel, listener) }
    const event = {} as IpcMainInvokeEvent
    let authorized = false
    const onResult = vi.fn()
    registerDesktopIpc({ handle }, handlers, { authorize: () => authorized, onResult })
    const channels: string[] = Object.values(DESKTOP_CHANNELS)
    expect([...listeners.keys()].every(channel => channels.includes(channel))).toBe(true)

    const list = listeners.get(DESKTOP_CHANNELS.projects)!
    expect(await list(event)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(request).not.toHaveBeenCalled()
    expect(onResult).not.toHaveBeenCalled()

    authorized = true
    expect(await list(event)).toEqual({ ok: true, result: ['合成结果'] })
    expect(request).toHaveBeenCalledOnce()
    expect(onResult).toHaveBeenCalledWith(event, DESKTOP_CHANNELS.projects, ['合成结果'])
  })
})
