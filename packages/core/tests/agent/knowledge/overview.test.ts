import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createAgentKnowledgeOverview, type AgentKnowledgeReadStore } from '../../../src/agent/knowledge/overview.js'

const owner = randomUUID(), other = randomUUID(), prefix = `${owner}/.agent/knowledge/entries/`
const doc = (id: string, options: { owner?: string; type?: string; at?: string; active?: string; title?: string } = {}) => new TextEncoder().encode([
  '---', `id: ${id}`, `title: ${options.title ?? id}`, 'topic: 主题', 'description: 描述',
  `scope_json: ${JSON.stringify({ owner_user_id: options.owner ?? owner, type: options.type ?? 'owner' })}`,
  'source_json: {"type":"user"}', `created_at: ${options.at ?? '2026-01-01T00:00:00.000000Z'}`,
  `updated_at: ${options.at ?? '2026-01-01T00:00:00.000000Z'}`, `active: ${options.active ?? 'true'}`, '---', '', '合成正文', '',
].join('\n'))
function fixture() {
  const files = new Map<string, Uint8Array>([
    [prefix + 'a.md', doc('a', { at: '2026-01-01T00:00:00.000001Z' })],
    [prefix + 'b.md', doc('b', { at: '2026-01-01T08:00:00.000002+08:00', title: '新版' })],
    [prefix + 'c.md', doc('c', { type: 'group' })],
    [prefix + 'd.md', doc('d', { owner: other })],
    [prefix + 'e.md', doc('e', { active: 'false' })],
    [prefix + 'broken.md', new TextEncoder().encode('合成损坏')],
    [prefix + 'bad-scope.md', new TextEncoder().encode(new TextDecoder().decode(doc('bad')).replace('\"type\":\"owner\"', '\"type\":7'))],
  ])
  const store: AgentKnowledgeReadStore = {
    async exists(key) { return key === `${owner}/.agent/knowledge/.timestamps-iso-v1` },
    async list(p, cursor) { const keys = [...files.keys()].filter(key => key.startsWith(p)); return cursor === null ? { keys: keys.slice(0, 3), nextCursor: 'next' } : { keys: keys.slice(3), nextCursor: null } },
    async read(key) { const value = files.get(key); if (!value) throw new Error('合成敏感输入'); return value },
  }
  return { files, store }
}
it('只读知识清单按 owner scope、有效状态和微秒排序', async () => {
  const { store } = fixture()
  expect(await createAgentKnowledgeOverview(store)(owner)).toEqual([
    { title: '新版', topic: '主题', description: '描述' }, { title: 'a', topic: '主题', description: '描述' },
  ])
})
it('缺迁移标记、存储失败和越域键均显式失败且不暴露底层错误', async () => {
  const { store } = fixture()
  await expect(createAgentKnowledgeOverview({ ...store, async exists() { return false } })(owner)).rejects.toMatchObject({ code: 'storage_error', message: '知识数据暂不可用' })
  await expect(createAgentKnowledgeOverview({ ...store, async read() { throw new Error('合成敏感输入') } })(owner)).rejects.toMatchObject({ code: 'storage_error', message: '知识数据暂不可用' })
  await expect(createAgentKnowledgeOverview({ ...store, async list() { return { keys: [`${other}/.agent/knowledge/entries/x.md`], nextCursor: null } } })(owner)).rejects.toMatchObject({ code: 'storage_error' })
  const controller = new AbortController(); controller.abort(new Error('合成取消'))
  await expect(createAgentKnowledgeOverview(store)(owner, controller.signal)).rejects.toThrow('合成取消')
})
