import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as reservePort } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { startServer } from '../../../../src/main.js'
import { applyAgentBaseMigration } from '@gugu/database/postgres/migrations/0001_initialize'
import { applyAgentRunMigration } from '@gugu/database/postgres/migrations/0003_agent_run'
import { applyWebDomainMigration } from '@gugu/database/postgres/migrations/0002_web_domain'
import { applyRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'
import { applyTrashPurgeMigration } from '@gugu/database/postgres/migrations/0009_trash_purge'
import { applyFilesystemAuthorizationMigration } from '@gugu/database/postgres/migrations/0005_filesystem_authorization'

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
const redisUrl = process.env.GUGU_WEBUI_TEST_REDIS_URL

test('生产 Node Agent 经 HTTP/SSE 触发 RAG Worker，隔离历史检索及 Linux 知识写入 owner', {
  skip: !(pgUrl && redisUrl) && '需要隔离 PostgreSQL 和 Redis', timeout: 45_000,
}, async () => {
  const schema = `agent_rag_main_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const schemaUrl = new URL(pgUrl!)
  schemaUrl.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: schemaUrl.toString() })
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-rag-main-'))
  const requests: string[] = []
  let searchCallIssued = false
  let knowledgeCallIssued = false
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = Buffer.concat(chunks).toString('utf8')
    requests.push(input)
    let choice
    if (input.includes('执行合成历史检索') && !searchCallIssued) {
      searchCallIssued = true
      choice = { delta: { tool_calls: [{ index: 0, id: 'synthetic-rag-search', type: 'function', function: {
        name: 'call_tool', arguments: JSON.stringify({ tool_name: 'search_conversations', arguments: { query: '月球RAG检索词' } }),
      } }] }, finish_reason: 'tool_calls' }
    } else if (process.platform === 'linux' && input.includes('执行合成知识保存') && !knowledgeCallIssued) {
      knowledgeCallIssued = true
      choice = { delta: { tool_calls: [{ index: 0, id: 'synthetic-rag-knowledge-save', type: 'function', function: {
        name: 'call_tool', arguments: JSON.stringify({ tool_name: 'save_knowledge', arguments: {
          title: '合成知识条目', topic: 'RAG Node 工具验收', content: '仅属于当前 owner 的合成知识正文。',
          keywords: ['合成知识', 'RAG'],
        } }),
      } }] }, finish_reason: 'tool_calls' }
    } else {
      choice = { delta: { content: '合成检索完成。' }, finish_reason: 'stop' }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
      `data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  })

  try {
    provider.listen(0, '127.0.0.1')
    await once(provider, 'listening')
    const providerAddress = provider.address()
    assert.ok(providerAddress && typeof providerAddress !== 'string')
    await admin.query(`CREATE SCHEMA "${schema}"`)
    assert.equal(await applyAgentBaseMigration(pool), 'applied')
    assert.equal(await applyFilesystemAuthorizationMigration(pool), 'applied')
    assert.equal(await applyWebDomainMigration(pool), 'applied')
    assert.equal(await applyAgentRunMigration(pool), 'applied')
    assert.equal(await applyRagIndexMigration(pool), 'applied')
    assert.equal(await applyTrashPurgeMigration(pool), 'applied')
    await pool.query('CREATE TABLE data_import_jobs (id uuid PRIMARY KEY, user_id uuid NOT NULL, status text NOT NULL)')

    const config = join(root, 'config.test.json')
    await writeFile(config, JSON.stringify({ agent: { memory_enabled: false } }))
    const probe = reservePort().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const address = probe.address()
    assert.ok(address && typeof address !== 'string')
    await new Promise<void>(resolve => probe.close(() => resolve()))
    host = await startServer({
      GUGU_WEBUI_DATABASE_URL: schemaUrl.toString(), GUGU_WEBUI_SECRET_KEY: 'synthetic-rag-secret',
      GUGU_WEBUI_REDIS_URL: redisUrl!, CREDENTIALS_MASTER_KEY: 'synthetic-rag-confirmation-key',
      GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(address.port), GUGU_CONFIG_OVERRIDE_FILE: config,
      STORAGE__LOCAL_PATH: join(root, 'storage'), AI__PROVIDER: 'local', AI__API_FORMAT: 'openai',
      AI__MODEL: 'synthetic-rag', AI__BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`, AI__API_KEY: 'synthetic-only',
      AI__CONTEXT_TOKENS: '65536', BYOK__ENABLED: 'false', MCP__ENABLED: 'false', SMTP__ENABLED: 'false',
      ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password',
    })
    const base = `http://127.0.0.1:${address.port}`
    const register = async (username: string) => {
      const response = await fetch(base + '/api/v1/auth/register', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': `device-${username}` },
        body: JSON.stringify({ username, email: `${username}@example.test`, password: 'Synthetic123!', locale: 'zh-CN' }),
        signal: AbortSignal.timeout(5000),
      })
      const body = await response.text()
      assert.equal(response.status, 201, body)
      return JSON.parse(body) as { access_token: string; user: { id: string } }
    }
    const owner = await register('north-sample')
    const foreign = await register('south-sample')
    const chat = (auth: string, message: string, sessionId?: number) => fetch(base + '/api/v1/agent/chat', {
      method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message, locale: 'zh-CN', session_id: sessionId }), signal: AbortSignal.timeout(8000),
    })
    const history = await chat(owner.access_token, '月球RAG检索词 owner-private-token')
    const historySse = await history.text()
    assert.equal(history.status, 200, historySse)
    assert.match(historySse, /"type":"done"/u)
    const sessionId = Number(historySse.match(/"session_id":(\d+)/u)?.[1])
    assert.ok(Number.isSafeInteger(sessionId) && sessionId > 0, historySse)
    const foreignHistory = await chat(foreign.access_token, '月球RAG检索词 foreign-private-token')
    const foreignSse = await foreignHistory.text()
    assert.equal(foreignHistory.status, 200, foreignSse)
    assert.match(foreignSse, /"type":"done"/u)

    const ownerId = owner.user.id
    const foreignId = foreign.user.id
    const indexed = async () => {
      const rows = await pool.query<{ owner_user_id: string; content: string }>(`SELECT owner_user_id,content FROM knowledge_index_entries
        WHERE source_type='conversation' AND content LIKE '%月球RAG检索词%' AND deleted_at IS NULL`)
      const foundOwners = new Set(rows.rows.map(row => row.owner_user_id))
      return foundOwners.has(ownerId) && foundOwners.has(foreignId)
    }
    const deadline = Date.now() + 8000
    while (!await indexed()) {
      if (Date.now() > deadline) throw new Error('Node RAG Worker 未为两个合成 owner 建立会话索引')
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const search = await chat(owner.access_token, '执行合成历史检索', sessionId)
    const searchSse = await search.text()
    assert.equal(search.status, 200, searchSse)
    assert.match(searchSse, /"type":"done"/u)
    assert.doesNotMatch(searchSse, /"type":"error"/u)
    assert.ok(searchSse.includes('search_conversations'), searchSse)
    const continuation = JSON.parse(requests.at(-1)!) as { messages: Array<{ role: string; content: unknown }> }
    const toolMessages = continuation.messages.filter(message => message.role === 'tool')
    assert.equal(toolMessages.length, 1)
    assert.match(JSON.stringify(toolMessages[0]?.content), /owner-private-token/u)
    assert.doesNotMatch(JSON.stringify(toolMessages[0]?.content), /foreign-private-token/u)
    assert.deepEqual((await pool.query<{ user_id: string }>(
      'SELECT user_id FROM conversation_sessions WHERE id=$1', [sessionId],
    )).rows, [{ user_id: ownerId }])

    if (process.platform === 'linux') {
      const knowledge = await chat(owner.access_token, '执行合成知识保存', sessionId)
      const knowledgeSse = await knowledge.text()
      assert.equal(knowledge.status, 200, knowledgeSse)
      assert.match(knowledgeSse, /"type":"done"/u)
      assert.doesNotMatch(knowledgeSse, /"type":"error"/u)
      assert.ok(knowledgeSse.includes('save_knowledge'), knowledgeSse)
      const indexedKnowledge = async () => (await pool.query<{ owner_user_id: string; content: string }>(`SELECT owner_user_id,content FROM knowledge_index_entries
        WHERE source_type='knowledge' AND content LIKE '%仅属于当前 owner 的合成知识正文%' AND deleted_at IS NULL`)).rows
      const knowledgeDeadline = Date.now() + 8000
      let knowledgeRows = await indexedKnowledge()
      while (!knowledgeRows.length) {
        if (Date.now() > knowledgeDeadline) throw new Error('Node RAG Worker 未为 save_knowledge 写入建立索引')
        await new Promise(resolve => setTimeout(resolve, 50))
        knowledgeRows = await indexedKnowledge()
      }
      assert.deepEqual(new Set(knowledgeRows.map(row => row.owner_user_id)), new Set([ownerId]))
    }

  } finally {
    await host?.close()
    provider.closeAllConnections()
    await new Promise<void>(resolve => provider.close(() => resolve()))
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
