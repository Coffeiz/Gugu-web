import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { installHttpErrorHandler } from '../../src/http/errors.js'
import { registerAdminPerceptionRoutes } from '../../src/domains/admin/admin-perception.js'

test('感知摘要在空数据和活跃门槛下不泄露事件明细', async () => {
  const app = Fastify()
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async () => {},
    events: async () => [{ t: 'perc', u: 'aaaaaaaa', ts: 1, intent: '查询', rawText: 'synthetic-private-body' }],
    misreadCases: async () => [],
    developerPrefixes: async () => new Set(),
    readMisread: async () => '',
    now: () => 10_000_000,
  })
  try {
    const response = await app.inject({ url: '/api/v1/admin/perception?hours=0&min_events=2' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.active_users, 0)
    assert.equal(body.perc_total, 0)
    assert.match(body.note, /暂无活跃用户/)
    assert.equal(JSON.stringify(body).includes('aaaaaaaa'), false)
  } finally {
    await app.close()
  }
})

test('感知摘要把误判关联最近一轮感知并按活跃用户宏平均', async () => {
  const app = Fastify()
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async () => {},
    events: async () => [
      { t: 'perc', u: 'aaaaaaaa', ts: 1, intent: '查询', model: 'm1', ambiguity: 20, emo: 2 },
      { t: 'misperc', u: 'aaaaaaaa', ts: 2, kind: '感知误读' },
      { t: 'perc', u: 'aaaaaaaa', ts: 3, intent: '闲聊', model: 'm1', ambiguity: 40, emo: 1, emotion: '委屈' },
      { t: 'fb', u: 'aaaaaaaa', ts: 4, v: '有用' },
    ],
    misreadCases: async () => [],
    developerPrefixes: async () => new Set(),
    readMisread: async () => '',
    now: () => 10_000_000,
  })
  try {
    const response = await app.inject({ url: '/api/v1/admin/perception?hours=0' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(body.active_users, 1)
    assert.equal(body.perc_total, 2)
    assert.equal(body.misperc_total, 1)
    assert.equal(body.overall_misperc_rate, 0.5)
    assert.equal(body.avg_ambiguity, 30)
    assert.equal(body.avg_emo_strength, 1.5)
    assert.equal(body.feedback_total, 1)
    assert.equal(body.intent_distribution.find((row: { intent: string }) => row.intent === '查询').misperc, 1)
  } finally {
    await app.close()
  }
})

test('感知错读预览先排除开发者再截取，导出仅返回脱敏结构事件', async () => {
  const app = Fastify()
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async () => {},
    events: async () => [{ t: 'perc', u: 'aaaaaaaa', ts: 1, intent: '查询' }],
    misreadCases: async () => [
      { u: 'aaaaaaaa', value: 'excluded' },
      { u: 'bbbbbbbb', value: 'kept' },
    ],
    developerPrefixes: async () => new Set(['aaaaaaaa']),
    readMisread: async () => '# 合成脱敏反思',
    now: () => 10_000_000,
  })
  try {
    const recent = await app.inject({ url: '/api/v1/admin/perception/misread/recent?n=1&exclude_dev=true' })
    assert.deepEqual(recent.json(), { total: 1, cases: [{ u: 'bbbbbbbb', value: 'kept' }] })
    const exported = await app.inject({ url: '/api/v1/admin/perception/export?hours=0' })
    assert.match(exported.headers['content-disposition'] ?? '', /perception_events_allh\.json/)
    assert.deepEqual(exported.json(), [{ t: 'perc', u: 'aaaaaaaa', ts: 1, intent: '查询' }])
    assert.equal(exported.body.includes('synthetic-private-body'), false)
  } finally {
    await app.close()
  }
})

test('分析路由拒绝未授权请求，时间窗和开发者过滤沿用查询语义', async () => {
  const app = Fastify()
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async (request, reply) => {
      if (request.headers.authorization !== 'admin') return reply.code(401).send({ error: 'unauthorized' })
    },
    events: async () => [
      { t: 'perc', u: 'aaaaaaaa', ts: 9_999, intent: '开发者数据' },
      { t: 'perc', u: 'bbbbbbbb', ts: 9_999, intent: '正常数据' },
      { t: 'perc', u: 'cccccccc', ts: 1, intent: '过期数据' },
    ],
    misreadCases: async () => [],
    developerPrefixes: async () => new Set(['aaaaaaaa']),
    readMisread: async () => '',
    now: () => 10_000_000,
  })
  try {
    assert.equal((await app.inject({ url: '/api/v1/admin/perception' })).statusCode, 401)
    const response = await app.inject({
      url: '/api/v1/admin/perception?hours=1&exclude_dev=true',
      headers: { authorization: 'admin' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().active_users, 1)
    assert.deepEqual(response.json().intent_distribution.map((row: { intent: string }) => row.intent), ['正常数据'])
  } finally {
    await app.close()
  }
})

test('感知异常标记和意图占比按阈值及用户宏平均返回', async () => {
  const app = Fastify()
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async () => {},
    events: async () => [
      ...Array.from({ length: 45 }, (_, i) => [
        { t: 'perc', u: 'aaaaaaaa', ts: i * 2 + 1, intent: '高误判', model: 'm1', ambiguity: 80 },
        ...(i < 12 ? [{ t: 'misperc', u: 'aaaaaaaa', ts: i * 2 + 1.5, kind: '数据/执行错' }] : []),
      ]).flat(),
      ...Array.from({ length: 5 }, (_, i) => ({ t: 'perc', u: 'aaaaaaaa', ts: 100 + i, intent: '其他', model: 'm1', ambiguity: 80 })),
      { t: 'perc', u: 'bbbbbbbb', ts: 110, intent: '高误判', model: 'm2', ambiguity: 80 },
      ...Array.from({ length: 49 }, (_, i) => ({ t: 'perc', u: 'bbbbbbbb', ts: 111 + i, intent: '其他', model: 'm2', ambiguity: 80 })),
    ],
    misreadCases: async () => [], developerPrefixes: async () => new Set(), readMisread: async () => '', now: () => 10_000_000,
  })
  try {
    const body = (await app.inject({ url: '/api/v1/admin/perception?hours=0&ambig_hi=60' })).json()
    const highIntent = body.intent_distribution.find((row: { intent: string }) => row.intent === '高误判')
    assert.equal(highIntent.pct, 46)
    assert.equal(highIntent.misperc_rate, 0.261)
    assert.equal(body.avg_ambiguity, 80)
    assert.ok(body.flag_items.some((item: { kind: string; intent?: string }) => item.kind === 'intent' && item.intent === '高误判'))
    assert.ok(body.flag_items.some((item: { kind: string }) => item.kind === 'ambiguity'))
    assert.ok(body.flag_items.some((item: { kind: string }) => item.kind === 'emotion_zero'))
    assert.ok(body.flag_items.some((item: { kind: string; model?: string }) => item.kind === 'model' && item.model === 'm1'))
    assert.match(body.flags[0], /高误判/)
  } finally {
    await app.close()
  }
})

test('错读反思为空时保持脱敏占位导出契约', async () => {
  const app = Fastify()
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async () => {},
    events: async () => [], misreadCases: async () => [], developerPrefixes: async () => new Set(),
    readMisread: async () => '',
  })
  try {
    const response = await app.inject({ url: '/api/v1/admin/perception/misread/export' })
    assert.equal(response.headers['content-type'], 'text/markdown; charset=utf-8')
    assert.match(response.body, /暂无/)
    assert.match(response.headers['content-disposition'] ?? '', /misread_reflections\.md/)
  } finally {
    await app.close()
  }
})

test('感知 Admin 查询参数遵守 FastAPI 标量类型校验并在调用数据源前返回 422', async () => {
  const app = Fastify()
  installHttpErrorHandler(app)
  let dependencyCalls = 0
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async () => {},
    events: async () => { dependencyCalls++; return [] },
    misreadCases: async () => { dependencyCalls++; return [] },
    developerPrefixes: async () => { dependencyCalls++; return new Set() },
    readMisread: async () => { dependencyCalls++; return '' },
  })
  try {
    const invalidQueries = [
      '/api/v1/admin/perception?hours=1.5',
      '/api/v1/admin/perception?limit=bad',
      '/api/v1/admin/perception?min_events=one',
      '/api/v1/admin/perception?rate_hi=bad',
      '/api/v1/admin/perception?rate_hi=0x10',
      '/api/v1/admin/perception?min_n=2.5',
      '/api/v1/admin/perception?ambig_hi=bad',
      '/api/v1/admin/perception?exclude_dev=perhaps',
      '/api/v1/admin/perception/export?hours=nope',
      '/api/v1/admin/perception/misread/recent?n=bad',
      '/api/v1/admin/perception/misread/recent?exclude_dev=perhaps',
    ]
    for (const url of invalidQueries) {
      const response = await app.inject({ url })
      assert.equal(response.statusCode, 422, url)
      assert.ok(response.json().detail, url)
    }
    assert.equal(dependencyCalls, 0)
  } finally {
    await app.close()
  }
})

test('感知 endpoint 不新增 Python 未声明的数值范围限制', async () => {
  const app = Fastify()
  registerAdminPerceptionRoutes(app, {
    requireAdmin: async () => {},
    events: async () => [], misreadCases: async () => [],
    developerPrefixes: async () => new Set(), readMisread: async () => '',
  })
  try {
    const response = await app.inject({ url: '/api/v1/admin/perception?hours=-1&min_events=-2&rate_hi=2' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().window_hours, -1)
    assert.equal(response.json().min_events, -2)
    assert.equal(response.json().thresholds.rate_hi, 2)
  } finally {
    await app.close()
  }
})
