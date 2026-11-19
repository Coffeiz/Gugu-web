import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { adminSearchTestSettings, createAdminSearchTest } from '../../src/modules/admin/search.js'
import { createAdminSearchProbe, registerAdminSearchTestRoute } from '../../src/modules/admin/search.js'
import type { ProviderHttpRequest, ProviderTransport } from '@gugu/core/providers'

test('搜索测试配置按 Python 顺序读取环境基础值并由 override 文件覆盖', () => {
  const environment = {
    SEARCH__TAVILY_API_KEY: 'env-tavily',
    SEARCH__DEEP_RESEARCH_PROVIDER: 'you',
    SEARCH__DEEP_RESEARCH_YOU_API_KEY: 'env-you',
  }
  assert.deepEqual(adminSearchTestSettings({ search: { tavily_api_key: 'override-tavily' } }, environment), {
    tavily_api_key: 'override-tavily', baidu_qianfan_api_key: '', deep_research_provider: 'you',
    deep_research_baidu_api_key: '', deep_research_you_api_key: 'env-you',
  })
})

test('搜索连通测试读取动态配置、显式 Key 优先且管理员认证生效', async () => {
  const probes: unknown[] = []
  const run = createAdminSearchTest({
    readSettings: () => ({ deep_research_provider: 'you', deep_research_you_api_key: 'saved-you-key' }),
    probe: async input => { probes.push(input); return { ok: true, has_results: true } },
  })
  const app = Fastify()
  registerAdminSearchTestRoute(app, { requireAdmin: async (request, reply) => {
    if (request.headers.authorization !== 'admin') return reply.code(401).send({ detail: '认证失败' })
  }, test: run })
  try {
    const payload = { target: 'deep_research' }
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/admin/config/test-search', payload })).statusCode, 401)
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/config/test-search', headers: { authorization: 'admin' }, payload })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true, message: 'OK — you 深度研究连接正常（本次测试可能消耗 1 次调用）' })
    assert.deepEqual(probes, [{ target: 'deep_research', provider: 'you', api_key: 'saved-you-key' }])
  } finally { await app.close() }
})

test('缺少凭据不探测；无结果深研失败，Tavily 和相似图成功复用同一业务规则', async () => {
  const calls: unknown[] = []
  const run = createAdminSearchTest({
    readSettings: () => ({ deep_research_provider: 'baidu', deep_research_baidu_api_key: 'saved-deep-baidu', baidu_qianfan_api_key: 'saved-baidu', tavily_api_key: 'saved-tavily' }),
    probe: async input => {
      calls.push(input)
      return input.target === 'deep_research' ? { ok: true, has_results: false } : { ok: true }
    },
  })
  assert.deepEqual(await run({ target: 'deep_research', deep_research_provider: 'unknown' }), { ok: false, message: '未配置 unknown 深度研究 API Key' })
  assert.deepEqual(await run({ target: 'deep_research' }), { ok: false, message: 'baidu 已连通但没有返回研究结果' })
  assert.deepEqual(await run({ target: 'tavily', tavily_api_key: 'draft-tavily' }), { ok: true, message: 'OK — Tavily Key 有效（本次测试消耗 1 次调用）' })
  assert.deepEqual(await run({ target: 'baidu_similar_images' }), { ok: true, message: '百度千帆相似图搜索连接正常（本次测试可能消耗 1 次调用）' })
  assert.deepEqual(calls, [
    { target: 'deep_research', provider: 'baidu', api_key: 'saved-deep-baidu' },
    { target: 'tavily', provider: 'tavily', api_key: 'draft-tavily' },
    { target: 'baidu_similar_images', provider: 'baidu', api_key: 'saved-baidu' },
  ])
})

test('Host 探针将深研与百度相似图接到共享 Core 协议和注入的 HTTP transport', async () => {
  const requests: ProviderHttpRequest[] = []
  const transport: ProviderTransport = {
    async request(input) {
      requests.push(input)
      const data = input.url.includes('tavily')
        ? { answer: '有结果', results: [{ title: '合成', url: 'https://result.example.test' }] }
        : { result: { res_data: { res_items: [{ title: '合成相似图', objurl: 'https://image.example.test' }] } } }
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: (async function* () { yield new TextEncoder().encode(JSON.stringify(data)) })(),
        cancel() {},
      }
    },
  }
  const probe = createAdminSearchProbe({}, { createTransport: () => transport })
  assert.deepEqual(await probe({ target: 'deep_research', provider: 'tavily', api_key: 'synthetic-tavily' }), { ok: true, has_results: true })
  assert.deepEqual(await probe({ target: 'baidu_similar_images', provider: 'baidu', api_key: 'synthetic-baidu' }), { ok: true })
  assert.equal(requests[0]?.url, 'https://api.tavily.com/search')
  assert.equal(requests[1]?.url, 'https://qianfan.baidubce.com/v2/tools/image_similar_info')
  assert.equal(JSON.stringify(requests.map(request => request.body)).includes('synthetic-tavily'), true)
  assert.equal(JSON.stringify(requests.map(request => request.headers)).includes('synthetic-baidu'), true)
})
