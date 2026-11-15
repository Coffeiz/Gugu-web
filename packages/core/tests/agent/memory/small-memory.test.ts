import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createSmallAgentMemory } from '../../../src/agent/memory/small-memory.js'
const owner = randomUUID(), base = `${owner}/.agent/`, encoder = new TextEncoder()
const make = (input: Record<string, string>) => createSmallAgentMemory({ async read(key) { if (!key.startsWith(base)) throw new Error('越域'); const v = input[key.slice(base.length)]; return v === undefined ? null : encoder.encode(v) } }, () => 86400 * 60)
it('规范小记忆按 Python 衰减、排序和格式返回真实内容', async () => {
  const read = make({
    'profile.json': JSON.stringify([{ type: 'note', text: ' 喜欢茶 ' }]),
    'pattern.json': JSON.stringify([{ text: '旧推断', kind: 'inferred', conf: 0.6, imp: 3, ts: 86400 * 15 }, { text: '事实', kind: 'observed', conf: 0.9, imp: 3, ts: 86400 * 40 }]),
    'memory.md': '  长期内容  ', 'daily.md': '最近记录', 'summary.json': JSON.stringify({ text: ' 状态 ', ts: 123 }),
    'stance.json': JSON.stringify({ stance: ' 讨论 ', ts: 234 }), 'lens.json': JSON.stringify({ rules: [{ rule: '先问', confidence: 0.8, last_seen: 86400 * 60 }] }),
  })
  const result = await read(owner)
  expect(result).toMatchObject({ profile: '- 喜欢茶', pattern: '- 事实\n- 旧推断（不太确定）', memory: '长期内容', daily: '最近记录', summary: '状态', summary_ts: 123, first_ts: 86400 * 15, stance: '讨论', stance_ts: 234 })
  expect(result.lens).toContain('- 先问')
})
it('旧数据、超预算和存储失败显式不可用，实际缺失可返回空记忆', async () => {
  expect(await make({})(owner)).toMatchObject({ profile: '', pattern: '', memory: '', summary: '', stance: null, lens: '' })
  const invalidFiles: Array<Record<string, string>> = [{ 'facts.md': '旧记忆' }, { 'pattern.json': '' }, { 'summary.md': '旧状态' }, { 'memory.md': '文'.repeat(3001) }, { 'pattern.json': JSON.stringify(Array.from({ length: 51 }, () => ({ text: 'a', kind: 'observed' }))) }]
  for (const files of invalidFiles)
    await expect(make(files)(owner)).rejects.toMatchObject({ code: 'storage_error' })
  const failing = createSmallAgentMemory({ async read() { throw new Error('合成敏感正文') } }, () => 0)
  await expect(failing(owner)).rejects.toMatchObject({ code: 'storage_error', message: '记忆数据暂不可用' })
})
it('预算边界使用 Unicode 字符，等于上限不触发外部检索', async () => {
  const patterns = Array.from({ length: 50 }, (_, index) => ({ text: `条目${index}`, kind: 'observed', conf: 0.9, imp: 3 }))
  const result = await make({ 'pattern.json': JSON.stringify(patterns), 'memory.md': '🙂'.repeat(3000), 'daily.md': '🙂'.repeat(2001) })(owner)
  expect(Array.from(result.memory)).toHaveLength(3000)
  expect(Array.from(result.daily)).toHaveLength(2000)
  expect(result.pattern.split('\n')).toHaveLength(50)
})
it('旧记忆不可用且取消原样传播', async () => {
  const controller = new AbortController(), reason = new Error('合成取消')
  controller.abort(reason)
  await expect(make({})(owner, controller.signal)).rejects.toBe(reason)
  await expect(make({ 'summary.json': '', 'summary.md': '旧内容' })(owner)).rejects.toMatchObject({ code: 'storage_error' })
  await expect(make({ 'pattern.json': '', 'facts.md': '旧内容' })(owner)).rejects.toMatchObject({ code: 'storage_error' })
})
