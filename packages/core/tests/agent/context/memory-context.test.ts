import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { loadAgentMemoryContext } from '../../../src/agent/memory/context.js'

const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'

describe('Agent 记忆上下文读取', () => {
  it('按 Python read_memory 聚合 owner 记忆字段并尊重直注入上限', async () => {
    const files: Record<string, string> = {
      [`${owner}/.agent/profile.json`]: JSON.stringify([
        { type: 'name', text: '小北', ts: 1 },
        { type: 'preference', text: '喜欢咖啡', ts: 2 },
      ]),
      [`${owner}/.agent/pattern.json`]: JSON.stringify([
        { id: 'p1', text: '喜欢猫', kind: 'observed', conf: 0.9, imp: 3, ts: 100 },
        { id: 'p2', text: '夜猫子', kind: 'inferred', conf: 0.6, imp: 3, ts: 50 },
      ]),
      [`${owner}/.agent/memory.md`]: '长期记忆正文',
      [`${owner}/.agent/daily.md`]: '今天聊了猫',
      [`${owner}/.agent/summary.json`]: JSON.stringify({ text: '在写代码', ts: 123.5 }),
      [`${owner}/.agent/stance.json`]: JSON.stringify({ stance: '闲聊', ts: 124.5 }),
      [`${owner}/.agent/lens.json`]: JSON.stringify({ rules: [{ rule: '先确认偏好', confidence: 0.8, last_seen: 124.5 }], candidates: [] }),
    }
    const read = async ({ key }: { ownerId: string; key: string; maxChars: number }) => files[key] ?? null

    await expect(loadAgentMemoryContext({ ownerId: owner, query: '', now: 125_000, storage: { readText: read } }))
      .resolves.toEqual({
        profile: '- 小北\n- 喜欢咖啡',
        pattern: '- 喜欢猫\n- 夜猫子',
        memory: '长期记忆正文',
        daily: '今天聊了猫',
        summary: '在写代码',
        summary_ts: 123.5,
        first_ts: 50,
        stance: '闲聊',
        stance_ts: 124.5,
        lens: expect.stringContaining('先确认偏好'),
      })
  })

  it('不接受无效 owner，并对超长 memory 与 daily 执行旧上下文预算', async () => {
    const files: Record<string, string> = {
      [`${owner}/.agent/memory.md`]: '甲'.repeat(3_400),
      [`${owner}/.agent/daily.md`]: '乙'.repeat(2_100),
    }
    const read = async ({ key }: { ownerId: string; key: string; maxChars: number }) => files[key] ?? null
    const result = await loadAgentMemoryContext({ ownerId: owner, query: '', now: 125_000, storage: { readText: read } })
    expect(result.memory.length).toBeLessThanOrEqual(3_000)
    expect(result.memory).toBe('甲'.repeat(3_000))
    expect(result.daily).toBe('乙'.repeat(2_000))
    await expect(loadAgentMemoryContext({ ownerId: '../other', query: '', now: 125_000, storage: { readText: read } }))
      .rejects.toThrow(/owner/u)
  })

  it('超过 pattern 注入上限时保留重要条目并优先补入与当前 query 相关的条目', async () => {
    const patterns = Array.from({ length: 50 }, (_, index) => ({
      id: `p${index}`, text: `无关模式${index}`, kind: 'observed', conf: 0.9, imp: 3, ts: 100,
    }))
    patterns.push({ id: 'related', text: '喜欢猫', kind: 'observed', conf: 0.9, imp: 3, ts: 100 })
    const files = { [`${owner}/.agent/pattern.json`]: JSON.stringify(patterns) }
    const result = await loadAgentMemoryContext({ ownerId: owner, query: '喜欢猫', now: 125_000,
      storage: { async readText({ key }) { return files[key] ?? null } } })
    expect(result.pattern.split('\n')).toHaveLength(50)
    expect(result.pattern).toContain('- 喜欢猫')
  })

  it('超限 snapshot 只 embed 一次，并按同模型向量为 pattern 与 memory 选相关内容', async () => {
    const patterns = Array.from({ length: 50 }, (_, index) => ({
      id: `p${index}`, text: `unrelated habit ${index}`, kind: 'observed', conf: 0.9, imp: 1, ts: 100,
    }))
    patterns.push({ id: 'semantic', text: 'prefers feline companions', kind: 'observed', conf: 0.9, imp: 1, ts: 100 })
    const first = '甲'.repeat(3200)
    const second = '乙'.repeat(1600)
    const memory = `${first}\n\n${second}`
    const files = { [`${owner}/.agent/pattern.json`]: JSON.stringify(patterns), [`${owner}/.agent/memory.md`]: memory }
    const chunkKey = (value: string) => createHash('md5').update(value.trim()).digest('hex').slice(0, 12)
    let embeds = 0
    const vectors = {
      pattern: Object.fromEntries(patterns.map(item => [item.id, { v: item.id === 'semantic' ? [1, 0] : [0, 1], t: 'model-a' }])),
      memory: { [chunkKey('甲'.repeat(400))]: { v: [1, 0], t: 'model-a' }, [chunkKey('乙'.repeat(400))]: { v: [0, 1], t: 'model-a' } },
    }
    const result = await loadAgentMemoryContext({ ownerId: owner, query: '猫', now: 125_000,
      storage: { async readText({ key }) { return files[key] ?? null } },
      vectorSearch: {
        async embed() { embeds += 1; return { vector: [1, 0], modelTag: 'model-a' } },
        async read(_ownerId, kind) { return vectors[kind] },
      },
    })
    expect(embeds).toBe(1)
    expect(result.pattern).toContain('prefers feline companions')
    expect(result.memory).toContain('甲')
    expect(result.memory).not.toContain('乙')
  })

  it('memory 文件读取发生取消时向调用方传播，不伪装成成功的空 snapshot', async () => {
    const controller = new AbortController()
    await expect(loadAgentMemoryContext({ ownerId: owner, query: '猫', now: 125_000, signal: controller.signal,
      storage: { async readText() { controller.abort(); return null } },
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('对齐旧版先按原始 pattern 数触发 embedding，再由退休过滤决定注入内容', async () => {
    const patterns = Array.from({ length: 50 }, (_, index) => ({
      id: `active-${index}`, text: `active pattern ${index}`, kind: 'observed', conf: 0.9, imp: 3, ts: 100,
    }))
    patterns.push({ id: 'retired', text: 'retired pattern', kind: 'observed', conf: 0.1, imp: 3, ts: 100 })
    let embeds = 0, reads = 0
    const result = await loadAgentMemoryContext({ ownerId: owner, query: '猫', now: 125_000,
      storage: { async readText({ key }) { return key.endsWith('/pattern.json') ? JSON.stringify(patterns) : null } },
      vectorSearch: {
        async embed() { embeds += 1; return { vector: [1], modelTag: 'model-a' } },
        async read() { reads += 1; return {} },
      },
    })
    expect(embeds).toBe(1)
    expect(reads).toBe(1)
    expect(result.pattern.split('\n')).toHaveLength(50)
    expect(result.pattern).not.toContain('retired pattern')
  })
})
