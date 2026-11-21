import { sql } from 'kysely'
import { appendDesktopAgentTurn, createDesktopAgentSession } from '../../../src/agent/sessions/desktop.js'
import { userMemoryVectorChunkKey } from '../../../src/byok/vector-rebuild.js'
import { expect, it, vi } from 'vitest'
import type { ProviderTransport } from '../../../src/agent/providers/contracts.js'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopMemoryFiles } from '../../../src/agent/memory/desktop-files.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { clearSqliteAgentMemory, createSqliteAgentMemoryRagVectors, createSqliteAgentMemoryVectorSearch, createSqliteMemorySearch } from '../../../src/agent/memory/sqlite.js'

const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'

it('桌面记忆查询和模式向量使用相同标签并限制 owner', async () => {
  const requests: unknown[] = []
  const close = vi.fn(async () => {})
  const transport: ProviderTransport = {
    async request(request) {
      requests.push(request)
      const input = String(request.body.input)
      const embedding = input === '当前问题' ? [1, 0] : [0, 1]
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: (async function* () { yield Buffer.from(JSON.stringify({ data: [{ embedding }] })) })(),
        cancel: async () => {},
      }
    },
    close,
  }
  const vectors = createSqliteAgentMemoryVectorSearch(owner,
    [{ id: 'pattern-1', text: '偏好茶', kind: 'observed', conf: 0.9, imp: 2, ts: 1 }],
    { provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'embed', apiKey: '', dimensions: 2, allowLocal: true },
    () => transport, '长期记忆正文')

  await expect(vectors.embed('c37421a3-8520-4c8b-92e5-736882f4bd82', '当前问题'))
    .rejects.toMatchObject({ message: 'RAG 检索未授权' })
  const query = await vectors.embed(owner, '当前问题')
  expect(query).toEqual({ vector: [1, 0], modelTag: expect.any(String) })
  await expect(vectors.read(owner, 'pattern')).resolves.toEqual({ 'pattern-1': { v: [0, 1], t: query?.modelTag } })
  await expect(vectors.read(owner, 'memory')).resolves.toEqual({
    [userMemoryVectorChunkKey('长期记忆正文')]: { v: [0, 1], t: query?.modelTag },
  })
  expect(requests).toHaveLength(3)
  await vectors.close()
  expect(close).toHaveBeenCalledOnce()
})


it('桌面记忆工具读取桌面记忆文件并调用本地 Embedding 进行混合排序', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-memory-search-'))
  const path = join(directory, 'core.db')
  await initializeSqlite(path)
  const { runtime, ownerId } = await openSqliteRuntime(path)
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push(String(JSON.parse(body).input))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }))
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('合成 Embedding 服务未监听')
    const disk = createDesktopMemoryFiles(runtime.db, directory, ownerId)
    await disk.initialize()
    await writeFile(join(directory, '.agent', 'memories', 'memory.md'), '## 记录长期记忆：早餐\ncoffee after lunch')
    const settings = {
      provider: 'local', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic',
      dimensions: 2, apiKey: '', allowLocal: true,
    }
    const createSearch = () => createSqliteMemorySearch(runtime.db, async () => true, settings, disk)
    const search = createSearch()
    const identity = { ownerId, sessionId: '1', runId: 'synthetic-memory-search' }
    const signal = new AbortController().signal
    await expect(search.search(identity, { query: 'coffee', scope: 'current_group' }, signal))
      .rejects.toThrow('RAG 检索未授权')
    expect(requests).toHaveLength(0)
    await expect(search.search(identity, { query: 'coffee', source: 'memory' }, signal)).resolves.toMatchObject({
      strategy: 'hybrid', results: [expect.objectContaining({ source_id: 'memory', text: expect.stringContaining('coffee after lunch') })],
    })
    expect(requests[0]).toBe('coffee')
    expect(requests[1]).toContain('coffee after lunch')
    await expect(createSearch().search(identity, { query: 'lunch', source: 'memory' }, signal))
      .resolves.toMatchObject({ strategy: 'hybrid' })
    expect(requests.slice(2)).toEqual(['lunch'])
    const rag = await createSqliteAgentMemoryRagVectors(runtime.db, ownerId, settings, disk)
    const document = {
      id: 'memory-chunk', text: requests[1]!, content: requests[1]!, source_type: 'memory',
      source_id: 'scope:synthetic:memory', metadata: { memory_source_id: 'memory' }, scope_type: 'owner', scope_id: '',
    }
    try {
      await expect(rag.readDocuments(ownerId, [document, {
        ...document, id: 'group-chunk', scope_type: 'group', scope_id: 'synthetic',
      }], signal)).resolves.toEqual({ 'memory-chunk': [1, 0] })
      expect(requests).toHaveLength(3)
      const pending = { ...document, id: 'new-memory-chunk', content: '新的长期记忆' }
      await rag.warmDocuments([pending, {
        ...pending, id: 'group-chunk', scope_type: 'group', scope_id: 'synthetic', content: '群聊内容',
      }], signal)
      await expect(rag.readDocuments(ownerId, [pending], signal)).resolves.toEqual({ 'new-memory-chunk': [1, 0] })
      expect(requests.slice(3)).toEqual(['新的长期记忆'])
    } finally { await rag.close() }
    const session = await runtime.db.transaction().execute(async tx => {
      const created = await createDesktopAgentSession(tx, ownerId, '历史会话')
      await appendDesktopAgentTurn(tx, ownerId, created.id, '历史问题', '历史回复')
      return created
    })
    await sql`UPDATE conversation_sessions SET execution_state='running' WHERE id=${session.id}`.execute(runtime.db)
    await expect(clearSqliteAgentMemory(runtime.db, ownerId, disk)).rejects.toMatchObject({ code: 'busy' })
    expect(await disk.readTarget('memory')).toContain('coffee after lunch')
    await sql`UPDATE conversation_sessions SET execution_state='idle' WHERE id=${session.id}`.execute(runtime.db)
    await clearSqliteAgentMemory(runtime.db, ownerId, disk)
    const history = await sql<{ content: string }>`SELECT content FROM conversation_messages WHERE session_id=${session.id}
      ORDER BY conversation_seq`.execute(runtime.db)
    expect(history.rows.map(row => row.content)).toEqual(['历史问题', '历史回复'])
    await expect(disk.readTarget('memory')).resolves.toBe('')
    await expect(disk.readMemoryVectors([userMemoryVectorChunkKey('## 记录长期记忆：早餐\ncoffee after lunch')]))
      .resolves.toEqual(new Map())
    await expect(search.search(identity, { query: 'coffee', source: 'memory' }, signal))
      .resolves.toMatchObject({ results: [] })
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('正文向量补算到达总截止时间时保留已完成结果', async () => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  const first = '## 记录长期记忆：第一条\n合成正文一'
  const second = '## 记录长期记忆：第二条\n合成正文二'
  const request = vi.fn<ProviderTransport['request']>()
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: (async function* () { yield Buffer.from('{"data":[{"embedding":[1,0]}]}') })(),
      cancel: async () => {},
    })
    .mockImplementationOnce(async (_request, signal) => {
      deadline.abort(new DOMException('正文补算已到截止时间', 'TimeoutError'))
      signal.throwIfAborted()
      throw new Error('预期请求已取消')
    })
  const vectors = createSqliteAgentMemoryVectorSearch(owner, [], {
    provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'deadline-test',
    apiKey: '', dimensions: 2, allowLocal: true,
  }, () => ({ request }), `${first}\n\n${second}`)
  try {
    await expect(vectors.read(owner, 'memory')).resolves.toEqual({
      [userMemoryVectorChunkKey(first)]: { v: [1, 0], t: expect.any(String) },
    })
    expect(request).toHaveBeenCalledTimes(2)
  } finally {
    timeout.mockRestore()
    await vectors.close()
  }
})
