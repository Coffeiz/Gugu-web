import { describe, expect, it } from 'vitest'
import { buildGreetingPrompt, createGreetingGenerator, normalizeGreetingLocale } from '../../../src/agent/scenes/greeting/index.js'

describe('对话问候', () => {
  it('按 Python 规则归一语言，并只把近况当作轻松话头', () => {
    expect(normalizeGreetingLocale('ja_JP')).toBe('ja-JP')
    expect(normalizeGreetingLocale('fr-FR')).toBe('zh-CN')
    const prompt = buildGreetingPrompt({
      locale: 'zh-CN', now: new Date('2026-11-16T08:00:00.000Z'), timeZone: 'Asia/Shanghai',
      lastMessageAt: new Date('2026-11-16T07:00:00.000Z'),
      stance: { value: '闲聊', updatedAt: new Date('2026-11-16T07:30:00.000Z') },
      projects: [{ name: '整理旅行照片', status: 'active', progress: 40 }],
      memory: { summary: '最近在旅行', summaryAt: new Date('2026-11-16T06:00:00.000Z'), profile: '喜欢慢旅行', daily: [{ date: '2026-11-15', note: '散步看海' }] },
    })
    expect(prompt).toContain('别说「好久不见」')
    expect(prompt).toContain('TA 最近 / 今天在弄的项目')
    expect(prompt).toContain('整理旅行照片')
    expect(prompt).not.toContain('进度：40%')
    expect(prompt).toContain('近 7 天记忆')
  })

  it('上下文缺失时使用无记忆开场规则且 locale 文案不混杂', () => {
    const prompt = buildGreetingPrompt({ locale: 'ja-JP', now: new Date('2026-11-16T08:00:00Z'), timeZone: 'UTC' })
    expect(prompt).toContain('没聊天记录')
    expect(prompt).toContain('自然な日本語')
    expect(prompt).not.toContain('请使用简体中文')
  })

  it('最近消息查询失败时不把数据库故障误报成用户没有历史', () => {
    const prompt = buildGreetingPrompt({ now: new Date('2026-11-16T08:00:00Z'), timeZone: 'UTC', lastMessageQueryFailed: true })
    expect(prompt).not.toContain('【上次和你说话】没有聊天记录')
  })

  it('关闭开关时不读取上下文、不调用模型或缓存', async () => {
    let reads = 0, completions = 0, cacheReads = 0
    const generate = createGreetingGenerator({
      enabled: () => false,
      async readContext() { reads++; return { timeZone: 'UTC' } },
      async complete() { completions++; return '你好' },
      cache: { async get() { cacheReads++; return null }, async set() {}, async acquire() { return null } },
    })
    await expect(generate('owner-a', 'zh-CN')).resolves.toEqual({ text: '', enabled: false })
    expect([reads, completions, cacheReads]).toEqual([0, 0, 0])
  })

  it('缓存命中复用同一 owner 与 locale 的问候', async () => {
    let completions = 0
    const generate = createGreetingGenerator({
      enabled: () => true,
      async readContext() { return { timeZone: 'UTC' } },
      async complete() { completions++; return '新的问候' },
      cache: { async get(key) { return key === 'agent:greeting:v2:owner-a:ja-JP' ? 'おかえり' : null }, async set() {}, async acquire() { throw new Error('命中缓存不应加锁') } },
    })
    await expect(generate('owner-a', 'ja-JP')).resolves.toEqual({ text: 'おかえり', enabled: true })
    expect(completions).toBe(0)
  })

  it('生成成功后清理引号并缓存十分钟', async () => {
    const writes: Array<[string, string, number]> = []
    let released = false
    const generate = createGreetingGenerator({
      enabled: () => true,
      async readContext() { return { timeZone: 'UTC' } },
      async complete(_owner, _prompt, maxTokens) { expect(maxTokens).toBe(180); return '「早呀，今天过得怎么样？」' },
      cache: {
        async get() { return null },
        async set(...args) { writes.push(args) },
        async acquire(_key, ttl, wait) { expect([ttl, wait]).toEqual([60, 15]); return { async release() { released = true } } },
      },
    })
    await expect(generate('owner-a', 'zh-CN')).resolves.toEqual({ text: '早呀，今天过得怎么样？', enabled: true })
    expect(writes).toEqual([['agent:greeting:v2:owner-a:zh-CN', '早呀，今天过得怎么样？', 600]])
    expect(released).toBe(true)
  })

  it('并发锁等待超时返回空问候且不额外生成', async () => {
    let completions = 0
    const generate = createGreetingGenerator({
      enabled: () => true,
      async readContext() { return { timeZone: 'UTC' } },
      async complete() { completions++; return '你好' },
      cache: { async get() { return null }, async set() {}, async acquire() { return null } },
    })
    await expect(generate('owner-a', 'zh-CN')).resolves.toEqual({ text: '', enabled: true })
    expect(completions).toBe(0)
  })

  it('缓存服务不可用时直接生成，不把缓存故障变成接口失败', async () => {
    let completions = 0
    const generate = createGreetingGenerator({
      enabled: () => true,
      async readContext() { return { timeZone: 'UTC' } },
      async complete() { completions++; return '  早上好  ' },
      cache: { async get() { throw new Error('redis unavailable') }, async set() {}, async acquire() { return null } },
    })
    await expect(generate('owner-a', 'zh-CN')).resolves.toEqual({ text: '早上好', enabled: true })
    expect(completions).toBe(1)
  })

  it('请求在缓存锁等待期间取消时立即传播取消，不继续读取上下文', async () => {
    const controller = new AbortController()
    let reads = 0
    const generate = createGreetingGenerator({
      enabled: () => true,
      async readContext() { reads++; return { timeZone: 'UTC' } },
      async complete() { return '不应生成' },
      cache: {
        async get() { return null }, async set() {},
        async acquire(_key, _ttl, _wait, signal) { controller.abort(); signal?.throwIfAborted(); return null },
      },
    })
    await expect(generate('owner-a', 'zh-CN', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(reads).toBe(0)
  })

  it('锁刚取得时请求取消也会释放缓存租约', async () => {
    const controller = new AbortController()
    let released = false
    const generate = createGreetingGenerator({
      enabled: () => true,
      async readContext() { return { timeZone: 'UTC' } },
      async complete() { return '不应生成' },
      cache: {
        async get() { return null }, async set() {},
        async acquire() { controller.abort(); return { async release() { released = true } } },
      },
    })
    await expect(generate('owner-a', 'zh-CN', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(released).toBe(true)
  })

  it('近七天记忆按用户本地日期截取，而非 UTC 日期', () => {
    const prompt = buildGreetingPrompt({ locale: 'zh-CN', now: new Date('2026-11-16T01:00:00.000Z'), timeZone: 'America/Los_Angeles',
      memory: { daily: [{ date: '2026-11-08', note: '本地七天窗口边界' }] } })
    expect(prompt).toContain('2026-11-08 本地七天窗口边界')
  })
})
