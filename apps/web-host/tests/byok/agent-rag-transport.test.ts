import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { embedRagQuery } from '@gugu/core/agent/rag'
import { createAgentRagEmbeddingTransport, createAgentRagEmbeddingTransportFactory } from '../../src/modules/byok/agent-rag-transport.js'
import { createOwnerAgentRagVectorResolver } from '../../src/domains/agent-sessions/tools/agent-rag-vectors.js'

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

test('生产向量查询关闭 transport 后，下次 embedding 会获得新实例并继续召回', async () => {
  let requests = 0
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('合成 embedding 服务未监听')
  const owner = '123e4567-e89b-12d3-a456-426614174000'
  const otherOwner = '123e4567-e89b-12d3-a456-426614174001'
  const resolve = createOwnerAgentRagVectorResolver({
    root: '/tmp/gugu-rag-vector-test',
    async resolveEmbedding() {
      return { provider: 'ollama', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic', apiKey: '', dimensions: 2, allowLocal: true }
    },
    createTransport: createAgentRagEmbeddingTransportFactory(() => ({})),
  })
  try {
    const [vectors, otherVectors] = await Promise.all([resolve(owner), resolve(otherOwner)])
    assert.ok(vectors)
    assert.ok(otherVectors)
    assert.deepEqual(await vectors.embed(owner, '第一次查询', new AbortController().signal), [0.5, 0.5])
    assert.deepEqual(await vectors.embed(owner, '第二次查询', new AbortController().signal), [0.5, 0.5])
    assert.equal(requests, 2, '前一轮关闭 transport 后，新查询仍必须实际完成 embedding 请求')
    assert.deepEqual(await vectors.embed(owner, '第一次查询'), [0.5, 0.5])
    assert.equal(requests, 2, '同一 owner 可复用自己的查询向量')
    assert.deepEqual(await otherVectors.embed(otherOwner, '第一次查询'), [0.5, 0.5])
    assert.equal(requests, 3, '异主相同查询仍需走各自的可信传输')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
