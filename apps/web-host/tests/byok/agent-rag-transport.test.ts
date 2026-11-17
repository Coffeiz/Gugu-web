import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { embedRagQuery } from '@gugu/core/agent'
import { createAgentRagEmbeddingTransport } from '../../src/modules/byok/agent-rag-transport.js'

test('生产 RAG transport 仅对 local/ollama query 开放本机 embedding 请求', async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('合成 embedding 服务未监听')
  const transport = createAgentRagEmbeddingTransport(() => ({}))
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  try {
    assert.deepEqual(await embedRagQuery({ provider: 'ollama', baseUrl, model: 'synthetic', apiKey: '', dimensions: 2, allowLocal: true }, '本地查询', transport, new AbortController().signal),
      { vector: [0.25, 0.75], outcome: 'success', httpStatus: 200 })
    assert.equal(requests, 1)
    assert.deepEqual(await embedRagQuery({ provider: 'openai', baseUrl, model: 'synthetic', apiKey: 'synthetic-key', dimensions: 2 }, '云端不得访问本机', transport, new AbortController().signal),
      { vector: [], outcome: 'network_error' })
    assert.equal(requests, 1)
  } finally {
    await transport.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
