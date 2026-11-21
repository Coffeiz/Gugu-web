import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createBuiltinSkillDefinitions } from '../../../src/agent/skills/builtin.js'
import { createSkillRegistry } from '../../../src/agent/skills/index.js'
import { createAgentSkillRuntimePorts } from '../../../src/agent/skills/runtime.js'
import { createBundledSkillDocuments } from '../../../dist/agent/skills/bundled.js'
import { discoverSkillDocuments } from '../../../scripts/build-skills.mjs'

const identity = { ownerId: '小北', sessionId: '1', runId: 'run' }
const signal = () => new AbortController().signal
function document(body = '正文') {
  return `---\nname: '写作'\ndescription: 简介\ncategory: write\nrelated_tools: [read_file, edit_file]\nmetadata:\n  emoji: ✍️\n---\n\n${body}\n`
}

describe('内置Skill文档到注册器', () => {
  it('自动扫描Markdown并按文件名生成连续编号', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-skill-discovery-'))
    try {
      await writeFile(join(directory, 'README.md'), '# 说明')
      await writeFile(join(directory, 'one.md'), document('第一个正文'))
      await writeFile(join(directory, 'two.md'), document('第二个正文').replace("name: '写作'", "name: '第二技能'"))
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
      ...Array.from({ length: 12 }, (_, index) => `S${index + 1}`),
    ])
    expect(catalog.find(item => item.key === 'chart-and-math')).toMatchObject({
      name: '图表与数学表达', description: expect.stringMatching(/Mermaid.*TeX/u), related_tools: [],
    })
    expect(catalog.find(item => item.key === 'im-bind')?.related_tools).toEqual([])
    expect(catalog.find(item => item.key === 'canvas')?.related_tools).toContain('present_file')
    expect((await registry.load('S4', identity, signal())).content).toContain('桌面工具返回的本机绝对路径')
    expect((await registry.load('S10', identity, signal())).content).toContain('managed_by=assistant')
  })
  it('扁平frontmatter提取元数据，正文digest对齐Python SHA256前16hex', async () => {
    const definitions = await createBuiltinSkillDefinitions([{ name: 'writing.md', read: async () => document('正文😀') }], signal())
    const registry = createSkillRegistry({ skills: definitions, authorize: async () => true })
    expect(await registry.catalog(identity)).toEqual([{ id: 'S1', name: '写作', description: '简介', key: 'writing', emoji: '✍️', category: 'write', source: 'builtin', related_tools: ['read_file', 'edit_file'] }])
    expect(await registry.load('S1', identity, signal())).toMatchObject({ content: '正文😀', contentDigest: createHash('sha256').update('正文😀', 'utf8').digest('hex').slice(0, 16) })
  })
  it('目录保留初始快照，正文实时更新，失效元数据拒绝', async () => {
    let source = document('初始')
    const definitions = await createBuiltinSkillDefinitions([{ name: 'writing.md', read: async () => source }], signal())
    const registry = createSkillRegistry({ skills: definitions, authorize: async () => true })
    source = document('修改正文').replace("name: '写作'", "name: '改名'")
    expect((await registry.catalog(identity))[0]?.name).toBe('写作')
    expect(await registry.load('S1', identity, signal())).toMatchObject({ name: '写作', content: '修改正文' })
    source = source.replace('description: 简介', 'description:')
    await expect(registry.load('S1', identity, signal())).rejects.toMatchObject({ code: 'load_failed' })
  })
  it('README不读取，非Skill文档跳过，重复文件拒绝而不是覆盖', async () => {
    const read = vi.fn(async () => document())
    expect(await createBuiltinSkillDefinitions([{ name: 'README.md', read }, { name: 'notes.md', read: async () => '普通说明' }], signal())).toEqual([])
    expect(read).not.toHaveBeenCalled()
    await expect(createBuiltinSkillDefinitions([{ name: 'a.md', read }, { name: 'a.md', read }], signal())).rejects.toThrow('内置技能文件名无效或重复')
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
  it('共享 Skill Runtime 只组合启用的合法用户项，并按可信 owner 重验正文来源', async () => {
    const builtins = await createBuiltinSkillDefinitions([{ name: 'builtin.md', read: async () => document('内置正文') }], signal())
    let enabled = true
    let body = '用户正文 v1'
    const runtimeIdentity = { ...identity, ownerId: '可信owner' }
    const runtime = await createAgentSkillRuntimePorts({
      ownerId: '可信owner',
      builtins,
      async listUser(owner) {
        expect(owner).toBe('可信owner')
        return { skills: [
          { id: 'U1', name: '个人技能', description_short: '个人说明', category: 'personal', related_tools: ['read_file'], enabled: true, source: 'user' },
          { id: 'U2', name: '已停用', description_short: '停用项', category: 'personal', related_tools: [], enabled: false, source: 'user' },
          { id: 'S3', name: '伪内置', description_short: '冲突项', category: 'personal', related_tools: [], enabled: true, source: 'user' },
        ] }
      },
      async readUser(owner, id) {
        return owner === '可信owner' && id === 'U1' && enabled
          ? { id, name: '个人技能', body, contentDigest: body.endsWith('v1') ? 'digest-v1' : 'digest-v2' }
          : null
      },
      fingerprint: owner => `owner:${owner}`,
    })
    expect((await runtime.skills.catalog(runtimeIdentity)).map(item => item.id)).toEqual(['S1', 'U1'])
    expect(await runtime.origin(runtimeIdentity, 'U1', signal())).toEqual({ source: 'user', ownerFingerprint: 'owner:可信owner' })
    expect((await runtime.skills.load('U1', runtimeIdentity, signal())).content).toBe('用户正文 v1')
    body = '用户正文 v2'
    expect((await runtime.skills.load('U1', runtimeIdentity, signal())).contentDigest).toBe('digest-v2')
    await expect(runtime.skills.catalog({ ...runtimeIdentity, ownerId: '其他owner' })).resolves.toEqual([])
    await expect(runtime.skills.load('U1', { ...runtimeIdentity, ownerId: '其他owner' }, signal())).rejects.toMatchObject({ code: 'unavailable' })
    enabled = false
    await expect(runtime.skills.load('U1', runtimeIdentity, signal())).rejects.toMatchObject({ code: 'unavailable' })
    await expect(runtime.origin({ ...runtimeIdentity, ownerId: '其他owner' }, 'U1', signal())).rejects.toThrow('技能来源无效')
  })
  it('旧编号配置按冻结映射应用，文件增删后保持稳定键', async () => {
    const docs = ['file-ops', 'chart-and-math', 'email'].map(key => ({
      name: `${key}.md`,
      read: async () => document(key),
    }))
    const configuration = { skills: { S3: false, email: true, S2: false, 'chart-and-math': true } }
    const definitions = await createBuiltinSkillDefinitions(docs, signal())
    expect(definitions.map(({ id, key }) => [id, key])).toEqual([
      ['S1', 'chart-and-math'], ['S2', 'email'], ['S3', 'file-ops'],
    ])
    const registry = createSkillRegistry({ skills: definitions, configuration, authorize: async () => true })
    expect((await registry.catalog(identity)).map(item => item.key)).toEqual(['chart-and-math', 'email'])
    const reordered = await createBuiltinSkillDefinitions(docs.filter(doc => doc.name !== 'chart-and-math.md'), signal())
    const after = createSkillRegistry({ skills: reordered, configuration, authorize: async () => true })
    expect((await after.catalog(identity)).map(({ id, key }) => [id, key])).toEqual([['S1', 'email']])
    await expect(after.load('S2', identity, signal())).rejects.toMatchObject({ code: 'unavailable' })
  })
})
