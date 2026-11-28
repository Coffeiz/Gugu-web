import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DESKTOP_CHANNELS } from '@gugu/core/desktop'
import { agentSessionHandlers } from '../src/main/agent/ipc.js'
import { createDesktopAgentModelService, createDesktopAgentModelStore } from '../src/main/agent/model.js'
import { CoreHost } from '../src/main/core-host.js'

it('确认新增 HTTP MCP 后展示独立的密码字段并保存测试凭据', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-mcp-'))
  const endpoint = 'https://mcp.example.test/mcp/'
  const secret = 'synthetic-mcp-test-secret'
  let providerMessages = ''
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const { messages } = JSON.parse(Buffer.concat(chunks).toString())
    providerMessages += JSON.stringify(messages)
    const completed = messages.some((message: { tool_call_id?: string }) => message.tool_call_id === 'mcp-add')
    const args = { action: 'add', server_name: 'test-mcp', endpoint: `[${endpoint}](${endpoint})`, transport: 'http', enabled: false,
      credential_slots: JSON.stringify([{ id: 'pat', label: '测试 PAT', target: 'header', parameter_name: 'Authorization', prefix: 'Bearer ' }]) }
    const delta = completed ? { content: '连接器已保存' } : { tool_calls: [{ index: 0, id: 'mcp-add', type: 'function',
      function: { name: 'manage_mcp_servers', arguments: JSON.stringify(args) } }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: completed ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  })
  let host: CoreHost | undefined
  try {
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const { port } = provider.address() as { port: number }
    const store = createDesktopAgentModelStore(directory, {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async value => Buffer.from(value),
      decryptStringAsync: async value => ({ result: value.toString(), shouldReEncrypt: false }),
    })
    const model = createDesktopAgentModelService(store)
    await model.save({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test-model', apiKey: 'synthetic-model-key' })
    host = await CoreHost.launch(process.execPath, resolve(import.meta.dirname, '../../../packages/core/dist/runtime/transport/stdio.js'),
      join(directory, 'core.db'), undefined, 15_000, undefined, undefined, resolve(import.meta.dirname, '../.tools/agent/runtime.mjs'))
    host.setHostRequestHandler(async ({ method }) => {
      if (method === 'agent.log.append') return { recorded: true }
      if (method === 'agent.tools.policy') return { disabledTools: [] }
      if (method === 'agent.files.overview') return { total: 0, folders: [], files: [], partial: false }
      if (method === 'agent.im.snapshot') return { feishu: false, qq: false, wechat: false, telegram: false }
      if (method.endsWith('.available')) return false
      throw new Error('未预期的宿主请求')
    })
    const send = agentSessionHandlers(host, model)[DESKTOP_CHANNELS.agentSessions]!
    const { id } = await send({ action: 'create', title: '测试连接器', operationId: randomUUID() }) as { id: number }
    await send({ action: 'send', id, stream: true, text: '添加测试连接器', operationId: randomUUID() }, () => {})
    type Event = { type: string; prompt_id: number; options?: Array<{ id: string; token: string }>; secret_fields?: unknown }
    const events = (runId?: string) => send({ action: 'events', id, ...(runId ? { runId } : {}) }) as Promise<{ runId: string; status: string; events: Event[] }>
    const page = await events()
    expect(page.status).toBe('waiting')
    const confirmation = page.events.find(event => event.type === 'interaction_required')!
    const token = confirmation.options?.find(option => option.id === 'confirm')?.token
    expect(token).toEqual(expect.any(String))
    await send({ action: 'respond', id, runId: page.runId, promptId: confirmation.prompt_id, token, operationId: randomUUID() })
    let form: Event | undefined
    await expect.poll(async () => {
      form = (await events()).events.find(event => event.type === 'interaction_required' && event.prompt_id !== confirmation.prompt_id)
      return form?.secret_fields
    }).toEqual([{ name: 'pat', label: '测试 PAT', type: 'secret' }])
    await send({ action: 'respond', id, runId: page.runId, promptId: form!.prompt_id, secrets: { pat: secret }, operationId: randomUUID() })
    await expect.poll(async () => (await events(page.runId)).status).toBe('completed')
    const { items } = await host.request<{ items: Array<{ id: string; name: string }> }>('mcp.list')
    const server = items.find(item => item.name === 'test-mcp')!
    await expect(host.request('mcp.config', { id: server.id })).resolves.toMatchObject({ endpoint, credential_values: { pat: secret } })
    expect(providerMessages).not.toContain(secret)
  } finally {
    await host?.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
