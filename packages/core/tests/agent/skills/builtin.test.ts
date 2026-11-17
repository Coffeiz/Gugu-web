import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createBuiltinSkillDefinitions } from '../../../src/agent/skills/builtin.js'
import { createSkillRegistry } from '../../../src/agent/skills/index.js'
import { createBundledSkillDocuments } from '../../../dist/agent/skills/bundled.js'
import { discoverSkillDocuments } from '../../../scripts/build-skills.mjs'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
const signal = () => new AbortController().signal
function document(body = '正文') {
  return `---\nid: S1\nname: '写作'\ndescription_short: 简介\ndescription_long: "完整介绍"\ncategory: write\nrelated_tools: [read_file, edit_file]\nmetadata:\n  emoji: ✍️\n---\n\n${body}\n`
}

describe('内置Skill文档到注册器', () => {
  it('自动扫描Markdown并按frontmatter头部ID生成注册项', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-skill-discovery-'))
    try {
      await writeFile(join(directory, 'README.md'), '# 说明')
      await writeFile(join(directory, 'one.md'), document('第一个正文'))
      await writeFile(join(directory, 'two.md'), document('第二个正文').replace('id: S1', 'id: S2').replace("name: '写作'", "name: '第二技能'"))
      const discovered = await discoverSkillDocuments(directory)
      const definitions = await createBuiltinSkillDefinitions(discovered.map(item => ({
        name: item.name,
        async read() { return item.content },
      })), signal())
      const registry = createSkillRegistry({ skills: definitions, authorize: async () => true })
      expect((await registry.catalog(identity)).map(item => item.id)).toEqual(['S1', 'S2'])
      expect((await registry.catalog(identity)).map(item => item.name)).toEqual(['写作', '第二技能'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('自动从资源目录Markdown的frontmatter发现并注册全部内置Skill', async () => {
    const definitions = await createBuiltinSkillDefinitions(createBundledSkillDocuments(), signal())
    const registry = createSkillRegistry({ skills: definitions, authorize: async () => true })
    const catalog = await registry.catalog(identity)
    expect(catalog.map(item => item.id).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))).toEqual([
      'S1', 'S2', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S12', 'S13',
    ])
    expect(catalog.find(item => item.id === 'S7')).toMatchObject({
      name: '图表与数学表达', description: '按问题选择 Mermaid 图表或数学公式表达，并检查语法与呈现格式。',
    })
  })
  it('扁平frontmatter提取元数据，正文digest对齐Python SHA256前16hex', async () => {
    const definitions = await createBuiltinSkillDefinitions([{ name: 'writing.md', read: async () => document('正文😀') }], signal())
    const registry = createSkillRegistry({ skills: definitions, authorize: async () => true })
    expect(await registry.catalog(identity)).toEqual([{ id: 'S1', name: '写作', description: '简介', description_short: '简介', description_long: '完整介绍', emoji: '✍️', category: 'write', source: 'builtin', related_tools: ['read_file', 'edit_file'] }])
    expect(await registry.load('S1', identity, signal())).toMatchObject({ content: '正文😀', contentDigest: createHash('sha256').update('正文😀', 'utf8').digest('hex').slice(0, 16) })
  })
  it('目录保留初始快照，正文实时更新，ID漂移拒绝', async () => {
    let source = document('初始')
    const definitions = await createBuiltinSkillDefinitions([{ name: 'writing.md', read: async () => source }], signal())
    const registry = createSkillRegistry({ skills: definitions, authorize: async () => true })
    source = document('修改正文').replace("name: '写作'", "name: '改名'")
    expect((await registry.catalog(identity))[0]?.name).toBe('写作')
    expect(await registry.load('S1', identity, signal())).toMatchObject({ name: '写作', content: '修改正文' })
    source = source.replace('id: S1', 'id: S2')
    await expect(registry.load('S1', identity, signal())).rejects.toMatchObject({ code: 'load_failed' })
  })
  it('README不读取，非Skill文档跳过，重复ID拒绝而不是覆盖', async () => {
    const read = vi.fn(async () => document())
    expect(await createBuiltinSkillDefinitions([{ name: 'README.md', read }, { name: 'notes.md', read: async () => '普通说明' }], signal())).toEqual([])
    expect(read).not.toHaveBeenCalled()
    await expect(createBuiltinSkillDefinitions([{ name: 'a.md', read }, { name: 'b.md', read }], signal())).rejects.toThrow('内置技能ID重复')
  })
  it('规范化CRLF但保留BOM语义，非YAML扁平值不解释', async () => {
    const definitions = await createBuiltinSkillDefinitions([{ name: 'writing.md', read: async () => document('\ufeff正文').replaceAll('\n', '\r\n') }], signal())
    expect(await definitions[0]!.load(identity, signal())).toMatchObject({ content: '\ufeff正文' })
  })
  it('读失败脱敏，取消传播', async () => {
    await expect(createBuiltinSkillDefinitions([{ name: 'writing.md', read: async () => { throw new Error('private-path-token') } }], signal())).rejects.toThrow('内置技能资源读取失败')
    const controller = new AbortController()
    const read = vi.fn(async () => document())
    controller.abort(new Error('取消加载'))
    await expect(createBuiltinSkillDefinitions([{ name: 'writing.md', read }], controller.signal)).rejects.toThrow('取消加载')
    expect(read).not.toHaveBeenCalled()
  })
  it('真实仓库builtin文档经过注册器加载，名称/目录与正文摘要一致', async () => {
    // 文件系统仅存在于可信Host测试端口；生产Core不依赖Python目录。
    const directory = new URL('../../../../../backend/agent/skills/', import.meta.url)
    const filenames = (await readdir(directory)).filter(name => name.endsWith('.md')).sort()
    const definitions = await createBuiltinSkillDefinitions(filenames.map(name => ({ name, read: async () => readFile(new URL(name, directory), 'utf8') })), signal())
    const registry = createSkillRegistry({ skills: definitions, authorize: async () => true })
    const catalog = await registry.catalog(identity)
    expect(catalog.length).toBe(13)
    expect(catalog.find(item => item.id === 'S13')).toMatchObject({ name: '联网搜索', emoji: '🔎', related_tools: ['web_search', 'similar_image_search', 'read_file', 'deep_research', 'http_get'] })
    for (const metadata of catalog) {
      const loaded = await registry.load(metadata.id, identity, signal())
      expect(loaded.content).not.toMatch(/^---/u)
      expect(loaded.contentDigest).toBe(createHash('sha256').update(loaded.content, 'utf8').digest('hex').slice(0, 16))
    }
  })
})
