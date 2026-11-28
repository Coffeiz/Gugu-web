import { createClawHubSearch, createClawHubSearchWithTransport } from '../../../src/agent/skills/clawhub.js'
import { createClawHubDownload, createClawHubPreview, readClawHubArchive } from '../../../src/agent/skills/clawhub-download.js'
import { zipSync, strToU8 } from 'fflate'
import { migrateLegacySkillBundle, migrateLegacySkillBundles, projectLegacySkillBundle } from '../../../src/agent/skills/migration.js'
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSkillDefinitions, createFileSkillRuntime, createFileSkillRegistry, createUserSkillBundle, createUserSkillBundleReader, discoverUserSkillBundles, isUserSkillBundleEnabled, listUserSkillBundles, readUserSkillBundle, withFileSkillMetadata } from '../../../src/agent/skills/bundle-store.js'
import { createAgentSkillRuntimePorts } from '../../../src/agent/skills/runtime.js'
import { describe, expect, it } from 'vitest'
import { createUserSkillDocument, parseSkillDocument, patchSkillDocument, serializeSkillDocument, userSkillDirectory } from '../../../src/agent/skills/bundle.js'
import { stageSkillPackage } from '../../../src/agent/skills/package-stage.js'

describe('技能包文档', () => {
  it('新建技能使用共享校验并保存元数据', () => {
    const fields = { name: '示例', description_short: '描述', description_long: '详情',
      category: 'personal', body: '正文', related_tools: ['read_file'], enabled: false }
    expect(parseSkillDocument(createUserSkillDocument(fields, new Set(['read_file'])))).toMatchObject({
      name: '示例', description: '描述', body: '正文', metadata: { metadata: { gugu: {
        enabled: false, description_long: '详情', category: 'personal', related_tools: ['read_file'], managed_by: 'user',
      } } },
    })
    expect(() => createUserSkillDocument(fields, new Set())).toThrow('未知工具')
  })

  it('保留上游嵌套元数据和正文原文', () => {
    const source = '---\r\nname: 示例\r\ndescription: |\r\n  第一行\r\n  第二行\r\nmetadata:\r\n  vendor:\r\n    requirements: [a, b]\r\n---\r\n正文\r\n'
    const skill = parseSkillDocument(source)
    expect(skill.name).toBe('示例')
    expect(skill.description).toBe('第一行\n第二行')
    expect(skill.frontmatter).toContain('requirements: [a, b]')
    expect(skill.metadata).toMatchObject({ metadata: { vendor: { requirements: ['a', 'b'] } } })
    expect(skill.source).toBe(source)
    expect(skill.body).toBe('正文\r\n')
  })

  it('本地字段可以生成可读取的技能包文档', () => {
    const source = serializeSkillDocument({ name: '示例', description: '描述', related_tools: ['list_projects'] }, '正文')
    expect(parseSkillDocument(source)).toMatchObject({ name: '示例', description: '描述', body: '正文' })
  })

  it('编辑与停用技能时保留其他 frontmatter 和未修改正文', () => {
    const original = '---\n# 保留说明\nname: 示例\ndescription: 描述\nmetadata:\n  openclaw:\n    requires:\n      bins: [git, node]\n  gugu:\n    custom: 保留\n---\n正文\n\n第二段\n'
    const changed = patchSkillDocument(original, { name: '新名称', enabled: false, relatedTools: ['search', 'search'] })
    const result = parseSkillDocument(changed)
    expect(result).toMatchObject({ name: '新名称', description: '描述', body: '正文\n\n第二段\n', metadata: {
      metadata: { openclaw: { requires: { bins: ['git', 'node'] } }, gugu: { custom: '保留', enabled: false, related_tools: ['search'] } },
    } })
    expect(changed).toContain('# 保留说明')
    const revived = parseSkillDocument(patchSkillDocument(changed, { enabled: true, body: '新正文\n' }))
    expect(revived).toMatchObject({ body: '新正文\n', metadata: { metadata: { gugu: { enabled: true, custom: '保留' } } } })
  })

  it('更新启用状态时拒绝覆盖非对象的第三方元数据', () => {
    const original = '---\nname: 示例\ndescription: 描述\nmetadata: 字符串\n---\n正文'
    expect(() => patchSkillDocument(original, { enabled: false })).toThrow('metadata 不是对象')
    expect(parseSkillDocument(original).metadata.metadata).toBe('字符串')
  })

  it('首次启停时为已有厂商元数据补充 Gugu 字段', () => {
    for (const metadata of ['', 'metadata:\n  openclaw:\n    requires: [git]\n']) {
      const original = `---\nname: 示例\ndescription: 描述\n${metadata}---\n正文`
      const result = parseSkillDocument(patchSkillDocument(original, { enabled: false }))
      expect(result.metadata).toMatchObject({ metadata: { gugu: { enabled: false } } })
      if (metadata) expect(result.metadata).toMatchObject({ metadata: { openclaw: { requires: ['git'] } } })
    }
  })

  it.each([
    '正文',
    '---\nname: 示例\nname: 重复\ndescription: 描述\n---\n',
    '---\nname: &alias 示例\ndescription: *alias\n---\n',
    '---\nname: 示例\ndescription: [描述]\n---\n',
  ])('拒绝无效或有歧义的 frontmatter %#', source => {
    expect(() => parseSkillDocument(source)).toThrow()
  })

  it('技能目录位于用户 UUID 下，拒绝路径穿越', () => {
    const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
    expect(userSkillDirectory('/synthetic', owner, 'demo-skill')).toBe(`/synthetic/${owner}/.agent/skills/demo-skill`)
    expect(() => userSkillDirectory('/synthetic', owner, '../other')).toThrow()
  })
})

it('从用户目录读取文档并拒绝目录指向其他位置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-bundle-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  try {
    const directory = userSkillDirectory(root, owner, 'demo')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: 示例\ndescription: 描述\n---\n正文')
    expect(await readUserSkillBundle(root, owner, 'demo')).toMatchObject({ name: '示例', body: '正文' })
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'SKILL.md'), '---\nname: 外部\ndescription: 描述\n---\n')
    await symlink(outside, userSkillDirectory(root, owner, 'escape'))
    await expect(readUserSkillBundle(root, owner, 'escape')).rejects.toThrow()
    await symlink(userSkillDirectory(root, owner, 'demo'), userSkillDirectory(root, owner, 'alias'))
    await expect(readUserSkillBundle(root, owner, 'alias')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('拒绝用户技能根目录指向其他用户的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-root-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  try {
    const target = join(root, 'other')
    await mkdir(join(target, 'demo'), { recursive: true })
    await writeFile(join(target, 'demo', 'SKILL.md'), '---\nname: 示例\ndescription: 描述\n---\n')
    const skillsRoot = join(root, owner, '.agent')
    await mkdir(skillsRoot, { recursive: true })
    await symlink(target, join(skillsRoot, 'skills'))
    await expect(readUserSkillBundle(root, owner, 'demo')).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('迁移记录保持原编号、停用状态及全部业务元数据', () => {
  const bundle = projectLegacySkillBundle({
    id: 'U42', name: '合成技能', description_short: '简述', description_long: '详细描述',
    category: 'creative', related_tools: ['list_projects'], body: '原正文\n', enabled: false, managed_by: 'assistant',
  })
  expect(bundle.slug).toBe('u42')
  expect(bundle.enabled).toBe(false)
  expect(parseSkillDocument(bundle.source)).toMatchObject({ name: '合成技能', body: '原正文\n' })
  expect(bundle.source).toContain('legacy_id: U42')
  expect(bundle.source).toContain('enabled: false')
  expect(bundle.source).toContain('description_long: 详细描述')
  expect(bundle.source).toContain('list_projects')
  expect(() => projectLegacySkillBundle({ id: '../other' } as never)).toThrow()
})

it('创建技能包并保留已存在的文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-create-skill-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const source = '---\nname: 示例\ndescription: 描述\n---\n原内容'
  try {
    const created = await createUserSkillBundle(root, owner, 'demo', source)
    expect(created.body).toBe('原内容')
    await expect(createUserSkillBundle(root, owner, 'demo', source)).rejects.toThrow()
    expect((await readUserSkillBundle(root, owner, 'demo')).body).toBe('原内容')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('迁移可重试，目标内容改变后拒绝覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-migration-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const skill = { id: 'U17', name: '合成技能', description_short: '描述', description_long: null,
    category: 'personal', related_tools: [], body: '原正文', enabled: true, managed_by: 'user' }
  try {
    expect(await migrateLegacySkillBundle(root, owner, skill)).toEqual({ slug: 'u17', enabled: true, created: true })
    expect(await migrateLegacySkillBundle(root, owner, skill)).toEqual({ slug: 'u17', enabled: true, created: false })
    await expect(migrateLegacySkillBundle(root, owner, { ...skill, body: '不同正文' })).rejects.toMatchObject({ code: 'conflict' })
    expect((await readUserSkillBundle(root, owner, 'u17')).body).toBe('原正文')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('批量迁移遇到后续目录冲突时不创建前面的技能', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-migration-conflict-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const skill = { id: 'U1', name: '示例', description_short: '描述', description_long: null,
    category: 'personal', related_tools: [], body: '原正文', enabled: true, managed_by: 'user' }
  try {
    await createUserSkillBundle(root, owner, 'u2', '---\nname: 已存在\ndescription: 描述\n---\n保留正文')
    await expect(migrateLegacySkillBundles(root, owner, async () => [skill, { ...skill, id: 'U2' }]))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(readFile(join(root, owner, '.agent', 'skills', 'u1', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readUserSkillBundle(root, owner, 'u2')).body).toBe('保留正文')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('Agent 读取器按可信授权映射加载当前文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-reader-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  try {
    await createUserSkillBundle(root, owner, 'u17', '---\nname: 示例\ndescription: 描述\n---\n第一版')
    const read = createUserSkillBundleReader({
      dataRoot: root, resolveSlug: async (candidate, id) => candidate === owner && id === 'U17' ? 'u17' : null,
    })
    const first = await read(owner, 'U17')
    expect(first).toMatchObject({ id: 'U17', name: '示例', body: '第一版' })
    await writeFile(join(userSkillDirectory(root, owner, 'u17'), 'SKILL.md'), '---\nname: 示例\ndescription: 描述\n---\n第二版')
    const second = await read(owner, 'U17')
    expect(second?.body).toBe('第二版')
    expect(second?.contentDigest).not.toBe(first?.contentDigest)
    expect(await read('00000000-0000-4000-8000-000000000001', 'U17')).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('发现用户技能时保留有效项并报告损坏目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-discovery-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  try {
    expect(await discoverUserSkillBundles(root, owner)).toEqual({ skills: [], invalid: [] })
    await createUserSkillBundle(root, owner, 'good', '---\nname: 示例\ndescription: 描述\n---\n正文')
    await mkdir(userSkillDirectory(root, owner, 'broken'))
    const result = await discoverUserSkillBundles(root, owner)
    expect(result.skills).toEqual([expect.objectContaining({ slug: 'good', name: '示例', description: '描述' })])
    expect(result.invalid).toEqual(['broken'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('管理列表读取当前用户文件技能和停用状态，不泄露物理路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-list-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const other = '00000000-0000-4000-8000-000000000001'
  try {
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 示例\ndescription: 描述\nmetadata:\n  gugu:\n    enabled: false\n    managed_by: assistant\n    related_tools: [search]\n---\n正文')
    await createUserSkillBundle(root, other, 'private', '---\nname: 其他用户\ndescription: 描述\n---\n正文')
    const result = await listUserSkillBundles(root, owner)
    expect(result.skills).toEqual([expect.objectContaining({ id: 'demo', enabled: false, managed_by: 'assistant',
      related_tools: ['search'], body: '正文', storage_kind: 'file' })])
    expect(JSON.stringify(result)).not.toContain(root)
    expect(JSON.stringify(result)).not.toContain('其他用户')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('技能工具目录列出当前用户的文件技能及映射目录，不返回正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-catalog-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  try {
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 示例\ndescription: 描述\nmetadata:\n  gugu:\n    enabled: false\n    related_tools: [search]\n---\n私密正文')
    await createUserSkillBundle(root, other, 'private', '---\nname: 其他用户\ndescription: 描述\n---\n正文')
    const list = withFileSkillMetadata({ dataRoot: root, list: async () => ({ count: 0, skills: [] }),
      mapPath: (_path, slug) => `/workspace/.agent/skills/${slug}` })
    const result = await list(owner, new AbortController().signal)
    expect(result).toEqual({ count: 1, skills: [expect.objectContaining({ id: 'demo', enabled: false,
      related_tools: ['search'], path: '/workspace/.agent/skills/demo' })] })
    expect(JSON.stringify(result)).not.toContain('私密正文')
    expect(JSON.stringify(result)).not.toContain('其他用户')
    expect(JSON.stringify(result)).not.toContain(root)
    const aborted = new AbortController()
    aborted.abort()
    await expect(list(owner, aborted.signal)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('文件技能注册器注入映射路径并按用户权限读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-registry-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const identity = { ownerId: owner, sessionId: '1', runId: 'run' }
  try {
    await createUserSkillBundle(root, owner, 'example', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const { registry } = await createFileSkillRegistry({ dataRoot: root, ownerId: owner, mapPath: (_, slug) => `/skills/${slug}`, isEnabled: async () => true })
    expect(await registry.catalog(identity)).toEqual([expect.objectContaining({ id: 'example', path: '/skills/example' })])
    expect(await registry.load('example', identity, new AbortController().signal)).toMatchObject({ content: '正文' })
    expect(await registry.catalog({ ...identity, ownerId: '00000000-0000-4000-8000-000000000001' })).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('批量迁移检查重复标识并支持再次执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-batch-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const item = { id: 'U17', name: '合成技能', description_short: '描述', description_long: null,
    category: 'personal', related_tools: [], body: '正文', enabled: false, managed_by: 'user' }
  try {
    await expect(migrateLegacySkillBundles(root, owner, async () => [item, item])).rejects.toMatchObject({ code: 'conflict' })
    expect(await migrateLegacySkillBundles(root, owner, async () => [item])).toEqual([{ slug: 'u17', enabled: false, created: true }])
    expect(await migrateLegacySkillBundles(root, owner, async () => [item])).toEqual([{ slug: 'u17', enabled: false, created: false }])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('从 SQLite 迁移时仅导出当前用户并保留停用状态', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect } = await import('kysely')
  const { createLegacySkillMigrationReader } = await import('../../../src/agent/skills/migration.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-sqlite-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const other = '00000000-0000-4000-8000-000000000001'
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  try {
    file.exec('CREATE TABLE user_skills(owner_id TEXT, skill_id TEXT, name TEXT, description_short TEXT, description_long TEXT, category TEXT, related_tools TEXT, body TEXT, enabled INTEGER, managed_by TEXT, source TEXT)')
    const insert = file.prepare('INSERT INTO user_skills VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run(owner.replaceAll('-', ''), 'U1', '当前用户', '描述', null, 'personal', '[]', '正文', 0, 'user', 'user')
    insert.run(other.replaceAll('-', ''), 'U2', '其他用户', '描述', null, 'personal', '[]', '其他正文', 1, 'user', 'user')
    const results = await migrateLegacySkillBundles(root, owner, createLegacySkillMigrationReader(db, 'sqlite'))
    expect(results).toEqual([{ slug: 'u1', enabled: false, created: true }])
    expect((await discoverUserSkillBundles(root, owner)).skills.map(skill => skill.name)).toEqual(['当前用户'])
    expect(await migrateLegacySkillBundles(root, owner, createLegacySkillMigrationReader(db, 'sqlite')))
      .toEqual([{ slug: 'u1', enabled: false, created: false }])
  } finally {
    await db.destroy()
    await rm(root, { recursive: true, force: true })
  }
})

it('Agent 从文件目录发现并通过 use_skill 加载技能', async () => {
  const { createToolRegistry } = await import('../../../src/agent/tools/registry.js')
  const { createUseSkillTool } = await import('../../../src/agent/tools/meta/index.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-agent-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const identity = { ownerId: owner, sessionId: '1', runId: 'run' }
  try {
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const runtime = await createFileSkillRuntime({ dataRoot: root, ownerId: owner,
      mapPath: (_, slug) => `/skills/${slug}`, fingerprint: () => 'owner-fingerprint', isEnabled: async () => true })
    const registry = createToolRegistry({ tools: [createUseSkillTool(runtime)], authorize: async () => true })
    const result = await registry.tools.dispatch({ id: 'call', name: 'use_skill', input: { id: 'demo' } }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('不得调用进程') },
    })
    expect(result).toMatchObject({ successful: true, value: { content: '正文', path: '/skills/demo',
      _capability_usage: { source: 'user', owner_fingerprint: 'owner-fingerprint' } } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('文件技能停用后不能再次列出或读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-disabled-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const identity = { ownerId: owner, sessionId: '1', runId: 'run' }
  let enabled = true
  try {
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const { registry } = await createFileSkillRegistry({ dataRoot: root, ownerId: owner,
      mapPath: (_, slug) => `/skills/${slug}`, isEnabled: async () => enabled })
    expect(await registry.catalog(identity)).toHaveLength(1)
    enabled = false
    expect(await registry.catalog(identity)).toEqual([])
    await expect(registry.load('demo', identity, new AbortController().signal)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('文件技能与内置技能共同注册并分别校验来源和用户权限', async () => {
  const { createBuiltinSkillDefinitions } = await import('../../../src/agent/skills/builtin.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-combined-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const identity = { ownerId: owner, sessionId: '1', runId: 'run' }
  const signal = new AbortController().signal
  try {
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 用户技能\ndescription: 描述\n---\n用户正文')
    const builtins = await createBuiltinSkillDefinitions([{ name: 'sample.md',
      read: async () => '---\nname: 内置技能\ndescription: 描述\n---\n内置正文' }], signal)
    const runtime = await createFileSkillRuntime({ dataRoot: root, ownerId: owner, builtins,
      mapPath: path => path, fingerprint: () => 'owner-fingerprint', isEnabled: async () => true })
    expect((await runtime.skills.catalog(identity)).map(skill => skill.id)).toEqual(['S1', 'demo'])
    expect(await runtime.origin(identity, 'S1', signal)).toEqual({ source: 'builtin' })
    expect(await runtime.origin(identity, 'demo', signal)).toEqual({ source: 'user', ownerFingerprint: 'owner-fingerprint' })
    expect((await runtime.skills.load('S1', identity, signal)).content).toBe('内置正文')
    const other = { ...identity, ownerId: '00000000-0000-4000-8000-000000000001' }
    expect(await runtime.skills.catalog(other)).toEqual([])
    await expect(runtime.origin(other, 'S1', signal)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('生产运行时能加载文件技能，停用后拒绝继续读取', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-runtime-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const identity = { ownerId: owner, sessionId: '1', runId: 'run' }
  const signal = new AbortController().signal
  const enabled = (user: string, slug: string) => isUserSkillBundleEnabled(root, user, slug)
  try {
    const skill = await createUserSkillBundle(root, owner, 'demo', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const { definitions } = await createFileSkillDefinitions({ dataRoot: root, ownerId: owner,
      mapPath: path => path, isEnabled: enabled })
    const runtime = await createAgentSkillRuntimePorts({ ownerId: owner, builtins: [], fileSkills: definitions,
      isFileSkillEnabled: enabled,
      fingerprint: () => 'owner-fingerprint' })
    expect(await runtime.skills.catalog(identity)).toEqual([expect.objectContaining({ id: 'demo', path: skill.path })])
    expect((await runtime.skills.load('demo', identity, signal)).content).toBe('正文')
    expect(await runtime.origin(identity, 'demo', signal)).toEqual({ source: 'user', ownerFingerprint: 'owner-fingerprint' })
    await writeFile(join(skill.path, 'SKILL.md'), '---\nname: 示例\ndescription: 描述\nmetadata:\n  gugu:\n    enabled: false\n---\n正文')
    expect(await runtime.skills.catalog(identity)).toEqual([])
    await expect(runtime.skills.load('demo', identity, signal)).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('ClawHub 搜索限制目标并校验返回数据', async () => {
  const search = createClawHubSearch(async (url) => {
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://clawhub.ai')
    expect(parsed.pathname).toBe('/api/v1/search')
    expect(parsed.searchParams.get('q')).toBe('资料 & 搜索')
    return { results: [{ slug: 'demo', displayName: '示例', summary: '描述', version: '1.0.0', ownerHandle: 'sample', canonicalUrl: '/sample/skills/demo', install: { kind: 'clawhub', reference: 'sample/demo' } }] }
  })
  expect(await search(' 资料 & 搜索 ', new AbortController().signal)).toEqual([
    { slug: 'demo', name: '示例', description: '描述', version: '1.0.0', owner: 'sample', reference: 'sample/demo', url: 'https://clawhub.ai/sample/skills/demo' },
  ])
  await expect(createClawHubSearch(async () => ({ results: '错误' }))('查询', new AbortController().signal)).rejects.toThrow()
})

it('ClawHub 标准搜索结果无需可选链接字段，来源不一致时拒绝', async () => {
  const row = { slug: 'gifgrep', displayName: 'GifGrep', summary: '图片搜索', version: '1.2.3', ownerHandle: 'openclaw' }
  const search = createClawHubSearch(async () => ({ results: [row] }))
  expect(await search('gif', new AbortController().signal)).toEqual([{ slug: 'gifgrep', name: 'GifGrep',
    description: '图片搜索', version: '1.2.3', owner: 'openclaw', reference: 'openclaw/gifgrep',
    url: 'https://clawhub.ai/openclaw/skills/gifgrep' }])
  const mismatched = createClawHubSearch(async () => ({ results: [{ ...row, canonicalUrl: '/other/skills/gifgrep' }] }))
  await expect(mismatched('gif', new AbortController().signal)).rejects.toThrow('来源不一致')
})

it('ClawHub 混合搜索跳过其他市场，不让单个外部条目中断搜索', async () => {
  const search = createClawHubSearch(async () => ({ results: [
    { slug: 'demo', displayName: '示例', ownerHandle: 'sample', source: 'clawhub' },
    { slug: 'other', displayName: '外部', ownerHandle: 'sample', source: 'skills-sh',
      canonicalUrl: '/skills-sh/sample/repo/other', install: { kind: 'skills-sh', reference: 'skills-sh:sample/repo/other' } },
  ] }))
  expect(await search('查询', new AbortController().signal)).toEqual([expect.objectContaining({ reference: 'sample/demo' })])
})

it('ClawHub 搜索通过受限传输读取，并拒绝重定向', async () => {
  const payload = JSON.stringify({ results: [{ slug: 'demo', displayName: '示例', summary: null,
    version: null, ownerHandle: 'sample', canonicalUrl: '/sample/skills/demo',
    install: { kind: 'clawhub', reference: 'sample/demo' } }] })
  let status = 200
  const transport = {
    async request(request: { url: string }, _signal: AbortSignal) {
      expect(new URL(request.url).hostname).toBe('clawhub.ai')
      return { status, headers: { 'content-type': 'application/json' },
        body: (async function* () { yield Buffer.from(payload) })(), cancel: async () => {} }
    },
  }
  const search = createClawHubSearchWithTransport(transport)
  expect(await search('demo', new AbortController().signal)).toEqual([
    expect.objectContaining({ slug: 'demo', reference: 'sample/demo' }),
  ])
  status = 302
  await expect(search('demo', new AbortController().signal)).rejects.toThrow()
})

it('ClawHub 下载保留整个技能包并通过固定目标获取', async () => {
  const archive = zipSync({ 'SKILL.md': strToU8('---\nname: 示例\ndescription: 描述\n---\n正文'),
    'references/guide.md': strToU8('参考资料'), 'assets/image.bin': new Uint8Array([0, 1, 2]) })
  const transport = {
    async request(request: { url: string }, _signal: AbortSignal) {
      const url = new URL(request.url)
      if (url.pathname === '/api/v1/skills/demo') {
        expect(url.origin).toBe('https://clawhub.ai')
        expect(url.searchParams.get('ownerHandle')).toBe('sample')
        return { status: 200, headers: { 'content-type': 'application/json' }, cancel: async () => {},
          body: (async function* () { yield Buffer.from(JSON.stringify({ owner: { handle: 'sample' },
            skill: { slug: 'demo', updatedAt: 1778485729679, stats: { downloads: 100, installs: 12, stars: 3 } },
            latestVersion: { version: '1.0.0', license: 'MIT' } })) })() }
      }
      expect(url.origin + url.pathname).toBe('https://clawhub.ai/api/v1/download')
      expect(url.searchParams.get('slug')).toBe('demo')
      expect(url.searchParams.get('ownerHandle')).toBe('sample')
      return { status: 200, headers: { 'content-type': 'application/zip' },
        body: (async function* () { yield archive })(), cancel: async () => {} }
    },
  }
  const files = await createClawHubDownload(transport)('@sample/demo', new AbortController().signal)
  expect([...files.keys()]).toEqual(['SKILL.md', 'references/guide.md', 'assets/image.bin'])
  expect([...files.get('assets/image.bin')!]).toEqual([0, 1, 2])
  await expect(createClawHubPreview(transport)('@sample/demo', new AbortController().signal)).resolves.toEqual({ body: '正文', details: { version: '1.0.0', updatedAt: 1778485729679, license: 'MIT', downloads: 100, installs: 12, stars: 3 } })
  await expect(createClawHubDownload(transport)('../escape', new AbortController().signal)).rejects.toThrow()
})

it('拒绝越界、重复及无入口的 ClawHub 压缩包', async () => {
  const skill = strToU8('---\nname: 示例\ndescription: 描述\n---\n正文')
  for (const contents of [
    { 'SKILL.md': skill, '../outside': strToU8('不允许') },
    { 'SKILL.md': skill, 'nested/file': strToU8('内容'), 'nested': strToU8('冲突') },
    { 'SKILL.md': skill, 'readme': strToU8('a'), 'README': strToU8('b') },
    { 'references/test': strToU8('缺少入口') },
  ]) await expect(readClawHubArchive(zipSync(contents), new AbortController().signal)).rejects.toThrow()
})

it('技能包暂存保留资源并交给宿主文件事务，失败后清理暂存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-stage-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  const files = new Map([
    ['SKILL.md', strToU8('---\nname: 示例\ndescription: 描述\n---\n正文')],
    ['references/a.md', strToU8('参考')],
  ])
  try {
    await expect(stageSkillPackage({ dataRoot: root, ownerId: owner, slug: 'demo', files,
      signal: new AbortController().signal, async commit(input) {
        expect(input.targetDirectory).toBe(join(root, owner, '.agent', 'skills', 'demo'))
        expect(await readFile(join(input.stagedDirectory, 'references/a.md'), 'utf8')).toBe('参考')
        throw new Error('合成事务失败')
      } })).rejects.toThrow('合成事务失败')
    expect(await readdir(join(root, owner, '.agent', '.skill-staging'))).toEqual([])
    const target = await stageSkillPackage({ dataRoot: root, ownerId: owner, slug: 'demo', files,
      signal: new AbortController().signal, async commit(input) {
        await mkdir(join(root, owner, '.agent', 'skills'))
        await rename(input.stagedDirectory, input.targetDirectory)
        return input.targetDirectory
      } })
    expect(await readFile(join(target, 'references/a.md'), 'utf8')).toBe('参考')
    await expect(stageSkillPackage({ dataRoot: root, ownerId: owner, slug: 'demo',
      files: new Map([...files, ['../escape', strToU8('危险')]]), signal: new AbortController().signal,
      async commit() { throw new Error('不得调用事务') } })).rejects.toThrow('技能包路径无效')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('技能暂存拒绝被符号链接重定向的用户目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-stage-link-'))
  const outside = await mkdtemp(join(tmpdir(), 'gugu-skill-stage-outside-'))
  const owner = 'e52bdfa2-4ed7-47ac-aedf-3da3c305aad3'
  try {
    await symlink(outside, join(root, owner))
    await expect(stageSkillPackage({ dataRoot: root, ownerId: owner, slug: 'demo',
      files: new Map([['SKILL.md', strToU8('---\nname: 示例\ndescription: 描述\n---\n正文')]]),
      signal: new AbortController().signal, async commit() {} })).rejects.toThrow('技能目录无效')
    await expect(createUserSkillBundle(root, owner, 'demo', '---\nname: 示例\ndescription: 描述\n---\n正文'))
      .rejects.toThrow('技能目录无效')
    expect(await readdir(outside)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

it('文件技能搜索支持关键词组合并隔离用户，不搜索正文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-search-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  try {
    const { createFileSkillSearchSource } = await import('../../../src/agent/skills/search.js')
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 文件整理\ndescription: 自动归档\n---\n秘密关键词')
    await createUserSkillBundle(root, other, 'private', '---\nname: 文件私有\ndescription: 自动归档\n---\n正文')
    const source = createFileSkillSearchSource(root)
    const query = { q: '文件 归档', queries: ['文件', '归档'], mode: 'AND' as const, perType: 10, types: ['skill' as const] }
    expect(await source.search(owner, query)).toEqual([{ id: 'demo', title: '文件整理', subtitle: '自动归档', enabled: true }])
    expect(await source.search(owner, { ...query, queries: ['秘密关键词'] })).toEqual([])
    expect(await source.search(owner, { ...query, queries: ['私有'] })).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('事务迁移只归档当前用户的旧记录，冲突时保留数据库并可安全重试', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect } = await import('kysely')
  const { cutoverLegacySkillBundles } = await import('../../../src/agent/skills/migration.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-cutover-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  try {
    file.exec(`CREATE TABLE user_skills(id INTEGER PRIMARY KEY, owner_id TEXT, skill_id TEXT, name TEXT, description_short TEXT, description_long TEXT, category TEXT, related_tools TEXT, body TEXT, enabled INTEGER, managed_by TEXT, source TEXT);
      CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY, user_id TEXT);
      CREATE TABLE conversation_messages(id INTEGER PRIMARY KEY, session_id INTEGER, references_json TEXT);
      CREATE TABLE mind_nodes(id INTEGER PRIMARY KEY, user_id TEXT, content_md TEXT, version INTEGER);
      CREATE TABLE conversation_pending_queues(user_id TEXT, queue_id TEXT, items TEXT)`)
    const insert = file.prepare('INSERT INTO user_skills(owner_id, skill_id, name, description_short, description_long, category, related_tools, body, enabled, managed_by, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run(owner.replaceAll('-', ''), 'U1', '第一项', '描述', null, 'personal', '[]', '正文一', 1, 'user', 'user')
    insert.run(owner.replaceAll('-', ''), 'U2', '第二项', '描述', null, 'personal', '[]', '正文二', 0, 'assistant', 'user')
    insert.run(other.replaceAll('-', ''), 'U1', '其他用户', '描述', null, 'personal', '[]', '其他正文', 1, 'user', 'user')
    file.prepare('INSERT INTO conversation_sessions VALUES (?, ?)').run(1, owner.replaceAll('-', ''))
    file.prepare('INSERT INTO conversation_sessions VALUES (?, ?)').run(2, other.replaceAll('-', ''))
    const references = JSON.stringify([{ type: 'skill', id: 'U1', label: '第一项' }, { type: 'skill', id: 2, label: '第二项' }, { type: 'project', id: 1, label: '项目' }])
    file.prepare('INSERT INTO conversation_messages VALUES (?, ?, ?)').run(1, 1, references)
    file.prepare('INSERT INTO conversation_messages VALUES (?, ?, ?)').run(2, 2, references)
    const markdown = '😀 [[skill:1|第一项]] 和 [[skill:U2|第二项]]\n`[[skill:1|示例]]`\n```\n[[skill:2|代码]]\n```\n\\[[skill:1|转义]]'
    file.prepare('INSERT INTO mind_nodes VALUES (?, ?, ?, ?)').run(1, owner.replaceAll('-', ''), markdown, 3)
    file.prepare('INSERT INTO mind_nodes VALUES (?, ?, ?, ?)').run(2, other.replaceAll('-', ''), markdown, 3)
    const queue = JSON.stringify([{ key: 1, references: [{ type: 'skill', id: 'U2', label: '第二项' }], _claim_token: 'token' }])
    file.prepare('INSERT INTO conversation_pending_queues VALUES (?, ?, ?)').run(owner.replaceAll('-', ''), 'draft', queue)
    await createUserSkillBundle(root, owner, 'u2', '---\nname: 冲突\ndescription: 保留\n---\n正文')
    const cutover = () => cutoverLegacySkillBundles({ db, backend: 'sqlite', dataRoot: root, ownerId: owner })
    await expect(cutover()).rejects.toMatchObject({ code: 'conflict' })
    expect(file.prepare('SELECT source FROM user_skills WHERE owner_id = ?').all(owner.replaceAll('-', ''))).toEqual([{ source: 'user' }, { source: 'user' }])
    expect(file.prepare('SELECT references_json FROM conversation_messages WHERE id=1').get()).toEqual({ references_json: references })
    await expect(readFile(join(root, owner, '.agent', 'skills', 'u1', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(join(root, owner, '.agent', 'skills', 'u2'), { recursive: true })
    expect(await cutover()).toEqual([{ slug: 'u1', enabled: true, created: true }, { slug: 'u2', enabled: false, created: true }])
    expect(file.prepare('SELECT source FROM user_skills WHERE owner_id = ?').all(owner.replaceAll('-', ''))).toEqual([{ source: 'migrated' }, { source: 'migrated' }])
    expect(file.prepare('SELECT source FROM user_skills WHERE owner_id = ?').get(other.replaceAll('-', ''))).toEqual({ source: 'user' })
    const message = file.prepare('SELECT references_json FROM conversation_messages WHERE id=1').get() as { references_json: string }
    expect(JSON.parse(message.references_json)).toEqual([{ type: 'skill', id: 'u1', label: '第一项' }, { type: 'skill', id: 'u2', label: '第二项' }, { type: 'project', id: 1, label: '项目' }])
    expect(file.prepare('SELECT references_json FROM conversation_messages WHERE id=2').get()).toEqual({ references_json: references })
    expect(file.prepare('SELECT content_md,version FROM mind_nodes WHERE id=1').get()).toEqual({ content_md: markdown.replace('[[skill:1|第一项]]', '[[skill:u1|第一项]]').replace('[[skill:U2|第二项]]', '[[skill:u2|第二项]]'), version: 4 })
    expect(file.prepare('SELECT content_md,version FROM mind_nodes WHERE id=2').get()).toEqual({ content_md: markdown, version: 3 })
    const pending = file.prepare('SELECT items FROM conversation_pending_queues').get() as { items: string }
    expect(JSON.parse(pending.items)).toEqual([{ key: 1, references: [{ type: 'skill', id: 'u2', label: '第二项' }], _claim_token: 'token' }])
    expect((await readUserSkillBundle(root, owner, 'u2')).body).toBe('正文二')
    expect(await cutover()).toEqual([])
  } finally { await db.destroy(); await rm(root, { recursive: true, force: true }) }
})

it('迁移笔记技能引用时保留转义、跨行代码和围栏', async () => {
  const { migrateMindSkillReferences } = await import('../../../src/agent/skills/migrate-mind.js')
  const markdown = '😀 [[skill:42|真实]]\r\n\\[[skill:42|转义]] \\\\[[skill:42|真实]]\n`跨行\n[[skill:42|代码]]`\n~~~\n[[skill:42|围栏]]\n~~~\n[[project:42|项目]]'
  expect(migrateMindSkillReferences(markdown, new Map([['42', 'u7']]))).toBe(
    '😀 [[skill:u7|真实]]\r\n\\[[skill:42|转义]] \\\\[[skill:u7|真实]]\n`跨行\n[[skill:42|代码]]`\n~~~\n[[skill:42|围栏]]\n~~~\n[[project:42|项目]]',
  )
})

it('文件技能删除确认绑定用户和整个目录，附属文件变化后拒绝确认', async () => {
  const { readFileSkillDeleteTarget, describeFileSkillDeleteTarget } = await import('../../../src/agent/tools/skill-management/file-delete-target.js')
  const { writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-delete-target-'))
  const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002'
  try {
    await createUserSkillBundle(root, owner, 'example', '---\nname: 示例技能\ndescription: 示例\n---\n正文')
    const target = await readFileSkillDeleteTarget(root, owner, 'example')
    expect(await describeFileSkillDeleteTarget(root, owner, { id: 'example' }, target)).toContain('示例技能')
    await expect(describeFileSkillDeleteTarget(root, other, { id: 'example' }, target)).rejects.toBeDefined()
    await writeFile(join(root, owner, '.agent', 'skills', 'example', 'reference.txt'), '新增内容')
    await expect(describeFileSkillDeleteTarget(root, owner, { id: 'example' }, target)).rejects.toMatchObject({ code: 'conflict' })
    await expect(readFileSkillDeleteTarget(root, owner, '../outside')).rejects.toMatchObject({ code: 'invalid_request' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('技能目录移动保留附属文件并可补偿，版本变化或其他用户不能移动', async () => {
  const { createLocalSkillPackageMover } = await import('../../../src/agent/skills/package-move.js')
  const { skillPackageDigest } = await import('../../../src/agent/skills/package-digest.js')
  const { writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-move-'))
  const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002'
  const operationId = `op-${'a'.repeat(32)}`
  try {
    await createUserSkillBundle(root, owner, 'example', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const path = join(root, owner, '.agent', 'skills', 'example')
    await writeFile(join(path, 'reference.txt'), '附属资料')
    const digest = await skillPackageDigest(path), mover = createLocalSkillPackageMover(root)
    await expect(mover.move({ ownerId: other, slug: 'example', operationId, digest, mode: 'undo' })).rejects.toBeDefined()
    const rollback = await mover.move({ ownerId: owner, slug: 'example', operationId, digest, mode: 'undo' })
    await expect(readFile(join(path, 'reference.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await rollback()
    expect(await readFile(join(path, 'reference.txt'), 'utf8')).toBe('附属资料')
    await writeFile(join(path, 'reference.txt'), '修改过')
    await expect(mover.move({ ownerId: owner, slug: 'example', operationId, digest, mode: 'undo' })).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(join(path, 'reference.txt'), 'utf8')).toBe('修改过')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('文件技能删除在确认通过前不触发删除端口', async () => {
  const { createFileSkillDeleteTool } = await import('../../../src/agent/tools/skill-management/file-delete.js')
  const { vi } = await import('vitest')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-delete-gate-'))
  const ownerId = '00000000-0000-4000-8000-000000000001'
  try {
    await createUserSkillBundle(root, ownerId, 'example', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const prepare = vi.fn(async () => ({ ok: true, value: { id: 'confirmation' } }))
    const verify = vi.fn(async () => ({ ok: false }))
    const remove = vi.fn(async () => ({ kind: 'completed' as const, successful: true, mutated: true, value: {} }))
    const reconcile = vi.fn(async () => ({ kind: 'unknown' as const }))
    const confirmation = { gate: { prepare, verify }, claim: vi.fn() } as unknown as Parameters<typeof createFileSkillDeleteTool>[1]
    const tool = createFileSkillDeleteTool(root, confirmation, { remove, reconcile })
    expect(tool.destructive).toBe(true)
    const scope = { identity: { ownerId, sessionId: '1', runId: 'run' }, roundId: 'round', signal: new AbortController().signal, resolution: null } as Parameters<typeof tool.execute>[1]
    const input = { id: 'example' }, call = { id: 'call', name: 'delete_skill', input }
    expect(tool.validate(input).success).toBe(true)
    expect(tool.validate({ id: '../outside' }).success).toBe(false)
    expect((await tool.execute(input, scope, call)).kind).toBe('waiting')
    expect(remove).not.toHaveBeenCalled()
    const confirmed = { ...scope, resolution: { status: 'confirmed' } } as unknown as typeof scope
    expect(await tool.execute(input, confirmed, call)).toMatchObject({ kind: 'completed', successful: false })
    expect(remove).not.toHaveBeenCalled()
    const claim = { intentId: 'intent' }
    verify.mockImplementationOnce(async () => ({ ok: true, value: claim }) as never)
    expect(await tool.execute(input, confirmed, call)).toMatchObject({ kind: 'completed', successful: true })
    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ slug: 'example' }), claim }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('文件技能删除收据失败后恢复，重试只认领一次确认并重放结果', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect, sql } = await import('kysely')
  const { SqlDataRuntime } = await import('../../../src/data/runtime.js')
  const { createDurableFileSkillDeletePort } = await import('../../../src/agent/tools/skill-management/file-delete-port.js')
  const { readFileSkillDeleteTarget } = await import('../../../src/agent/tools/skill-management/file-delete-target.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-delete-port-'))
  const ownerId = '00000000-0000-4000-8000-000000000001'
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  file.exec(`CREATE TABLE core_operation_receipts(owner_id TEXT,operation_id TEXT,fingerprint TEXT,method TEXT,result_json TEXT,created_at TEXT,PRIMARY KEY(owner_id,operation_id));
    CREATE TABLE claims(id TEXT); CREATE TRIGGER reject_receipt BEFORE INSERT ON core_operation_receipts BEGIN SELECT RAISE(ABORT, '合成错误'); END;`)
  const core = new SqlDataRuntime(db as never, 'sqlite')
  let held = false, count = 0, recovered = 0
  try {
    await createUserSkillBundle(root, ownerId, 'example', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const confirmation = { async claim(tx: typeof db) { await sql`INSERT INTO claims VALUES('claim')`.execute(tx); return true } } as unknown as Parameters<typeof createDurableFileSkillDeletePort>[0]['confirmation']
    const port = createDurableFileSkillDeletePort({ core, dataRoot: root, confirmation, async authorize() { return true }, storage: {
      async lock() {}, async recover() { if (held) { held = false; recovered++ } },
      async remove() { held = true; count++; return { async rollback() { held = false }, async finalize() {} } },
      async published() {},
    } })
    const identity = { ownerId, sessionId: '1', runId: 'run' }, scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.remove>[0]['scope']
    const call = { id: 'delete', name: 'delete_skill', input: { id: 'example' } }
    const target = await readFileSkillDeleteTarget(root, ownerId, 'example')
    const request = { target, scope, call, claim: {} as Parameters<typeof port.remove>[0]['claim'] }
    expect(await port.remove(request)).toEqual({ kind: 'unknown' })
    expect([held, count, recovered]).toEqual([false, 1, 1])
    expect(file.prepare('SELECT count(*) AS n FROM claims').get()).toEqual({ n: 0 })
    file.exec('DROP TRIGGER reject_receipt')
    expect(await port.remove(request)).toMatchObject({ kind: 'completed', successful: true, mutated: true })
    expect(await port.reconcile({ id: 'example', identity: { ...identity, roundId: 'round' }, call })).toMatchObject({ kind: 'completed', successful: true, mutated: false })
    expect([held, count]).toEqual([true, 2])
    expect(file.prepare('SELECT count(*) AS n FROM claims').get()).toEqual({ n: 1 })
  } finally { await core.close(); await rm(root, { recursive: true, force: true }) }
})

it('本地技能删除在收据失败后恢复整个目录并允许重试', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect, sql } = await import('kysely')
  const { SqlDataRuntime } = await import('../../../src/data/runtime.js')
  const { createDurableFileSkillDeletePort } = await import('../../../src/agent/tools/skill-management/file-delete-port.js')
  const { createLocalFileSkillDeleteStorage } = await import('../../../src/agent/tools/skill-management/file-delete-storage.js')
  const { readFileSkillDeleteTarget } = await import('../../../src/agent/tools/skill-management/file-delete-target.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-delete-local-'))
  const ownerId = '00000000-0000-4000-8000-000000000001'
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  file.exec(`CREATE TABLE core_operation_receipts(owner_id TEXT,operation_id TEXT,fingerprint TEXT,method TEXT,result_json TEXT,created_at TEXT,PRIMARY KEY(owner_id,operation_id));
    CREATE TABLE history(id TEXT); CREATE TRIGGER reject_receipt BEFORE INSERT ON core_operation_receipts BEGIN SELECT RAISE(ABORT, '合成错误'); END;`)
  const core = new SqlDataRuntime(db as never, 'sqlite')
  try {
    await createUserSkillBundle(root, ownerId, 'example', '---\nname: 示例\ndescription: 描述\n---\n正文')
    const directory = join(root, ownerId, '.agent', 'skills', 'example')
    await writeFile(join(directory, 'reference.txt'), '附属资料')
    const confirmation = { async claim() { return true } } as unknown as Parameters<typeof createDurableFileSkillDeletePort>[0]['confirmation']
    const storage = createLocalFileSkillDeleteStorage({ dataRoot: root, async lock() {}, async publish() {},
      async record(tx, entry) { await sql`INSERT INTO history VALUES(${entry.operationId})`.execute(tx) } })
    const port = createDurableFileSkillDeletePort({ core, dataRoot: root, storage, confirmation, async authorize() { return true } })
    const identity = { ownerId, sessionId: '1', runId: 'run' }, scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.remove>[0]['scope']
    const call = { id: 'delete', name: 'delete_skill', input: { id: 'example' } }
    const target = await readFileSkillDeleteTarget(root, ownerId, 'example')
    const request = { target, scope, call, claim: {} as Parameters<typeof port.remove>[0]['claim'] }
    expect(await port.remove(request)).toEqual({ kind: 'unknown' })
    expect(await readFile(join(directory, 'reference.txt'), 'utf8')).toBe('附属资料')
    expect(file.prepare('SELECT count(*) AS n FROM history').get()).toEqual({ n: 0 })
    file.exec('DROP TRIGGER reject_receipt')
    expect(await port.remove(request)).toMatchObject({ kind: 'completed', successful: true })
    await expect(readFile(join(directory, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(file.prepare('SELECT count(*) AS n FROM history').get()).toEqual({ n: 1 })
    expect(await port.reconcile({ id: 'example', identity: { ...identity, roundId: 'round' }, call })).toMatchObject({ kind: 'completed', successful: true, mutated: false })
  } finally { await core.close(); await rm(root, { recursive: true, force: true }) }
})

it('迁移提交失败后保留旧记录，已写文件可用于再次尝试', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect } = await import('kysely')
  const { cutoverLegacySkillBundles } = await import('../../../src/agent/skills/migration.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-cutover-retry-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  try {
    file.exec(`CREATE TABLE user_skills(id INTEGER PRIMARY KEY, owner_id TEXT, skill_id TEXT, name TEXT, description_short TEXT, description_long TEXT,
      category TEXT, related_tools TEXT, body TEXT, enabled INTEGER, managed_by TEXT, source TEXT);
      CREATE TABLE conversation_sessions(id INTEGER PRIMARY KEY, user_id TEXT);
      CREATE TABLE conversation_messages(id INTEGER PRIMARY KEY, session_id INTEGER, references_json TEXT);
      CREATE TABLE mind_nodes(id INTEGER PRIMARY KEY, user_id TEXT, content_md TEXT, version INTEGER);
      CREATE TABLE conversation_pending_queues(user_id TEXT, queue_id TEXT, items TEXT);
      CREATE TRIGGER reject_skill_archive BEFORE UPDATE OF source ON user_skills
      WHEN NEW.source='migrated' BEGIN SELECT RAISE(ABORT, '合成数据库错误'); END;`)
    file.prepare('INSERT INTO user_skills(owner_id,skill_id,name,description_short,description_long,category,related_tools,body,enabled,managed_by,source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(owner.replaceAll('-', ''), 'U1', '示例', '描述', null, 'personal', '[]', '原正文', 1, 'user', 'user')
    file.prepare('INSERT INTO conversation_sessions VALUES (?, ?)').run(1, owner.replaceAll('-', ''))
    const references = JSON.stringify([{ type: 'skill', id: 'U1', label: '示例' }])
    file.prepare('INSERT INTO conversation_messages VALUES (?, ?, ?)').run(1, 1, references)
    const cutover = () => cutoverLegacySkillBundles({ db, backend: 'sqlite', dataRoot: root, ownerId: owner })
    await expect(cutover()).rejects.toThrow('合成数据库错误')
    expect(file.prepare('SELECT source FROM user_skills').get()).toEqual({ source: 'user' })
    expect(file.prepare('SELECT references_json FROM conversation_messages').get()).toEqual({ references_json: references })
    expect((await readUserSkillBundle(root, owner, 'u1')).body).toBe('原正文')
    file.exec('DROP TRIGGER reject_skill_archive')
    expect(await cutover()).toEqual([{ slug: 'u1', enabled: true, created: false }])
    expect(file.prepare('SELECT source FROM user_skills').get()).toEqual({ source: 'migrated' })
    const message = file.prepare('SELECT references_json FROM conversation_messages').get() as { references_json: string }
    expect(JSON.parse(message.references_json)[0].id).toBe('u1')
  } finally { await db.destroy(); await rm(root, { recursive: true, force: true }) }
})

it('Agent 文件技能写入只接受受限字段并将身份交给宿主事务', async () => {
  const { createFileSkillManagementWriteTools } = await import('../../../src/agent/tools/skill-management/file-tools.js')
  const { vi } = await import('vitest')
  const execute = vi.fn(async () => ({ kind: 'completed' as const, successful: true, mutated: true, value: { id: 'demo' } }))
  const reconcile = vi.fn(async () => ({ kind: 'unknown' as const }))
  const tools = createFileSkillManagementWriteTools({ execute, reconcile })
  const create = { skill_name: '整理', description_short: '整理资料', body: '正文', related_tools: [], managed_by: 'assistant' }
  const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' }
  const scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof tools[0]['execute']>[1]
  const call = { id: 'call', name: 'create_skill', input: create }
  expect(tools[0]!.validate(create).success).toBe(true)
  expect(tools[0]!.validate({ ...create, ownerId: identity.ownerId }).success).toBe(false)
  expect(tools[1]!.validate({ id: '../outside', body: '改' }).success).toBe(false)
  expect(tools[1]!.validate({ id: 'demo' }).success).toBe(false)
  expect(tools[1]!.validate({ id: 'demo', body: '新正文' }).success).toBe(true)
  await tools[0]!.execute(create, scope, call)
  expect(execute).toHaveBeenCalledWith('create', create, scope, call)
  await tools[0]!.reconcile!(create, { ...identity, roundId: 'round' }, call)
  expect(reconcile).toHaveBeenCalledWith('create', create, { ...identity, roundId: 'round' }, call)
  const update = { id: 'demo', enabled: false }
  const updateCall = { id: 'update-call', name: 'update_skill', input: update }
  await tools[1]!.execute(update, scope, updateCall)
  expect(execute).toHaveBeenCalledWith('update', update, scope, updateCall)
  await tools[1]!.reconcile!(update, { ...identity, roundId: 'round' }, updateCall)
  expect(reconcile).toHaveBeenCalledWith('update', update, { ...identity, roundId: 'round' }, updateCall)
})

it('Agent 创建技能时在文档保留管理者和已校验的关联工具', () => {
  const source = createUserSkillDocument({ name: '整理', description_short: '整理资料', description_long: null,
    category: 'personal', body: '正文', related_tools: ['read_file'], managed_by: 'assistant' }, new Set(['read_file']))
  expect(parseSkillDocument(source).metadata).toMatchObject({ metadata: { gugu: { managed_by: 'assistant', related_tools: ['read_file'] } } })
  expect(() => createUserSkillDocument({ name: '整理', description_short: '整理资料', description_long: null,
    category: 'personal', body: '正文', related_tools: ['unknown'] }, new Set())).toThrow('未知工具')
})

it('文件技能写入使用持久收据重放，授权撤销时补偿文件修改', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect } = await import('kysely')
  const { SqlDataRuntime } = await import('../../../src/data/runtime.js')
  const { createDurableFileSkillManagementPort } = await import('../../../src/agent/tools/skill-management/file-port.js')
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  file.exec('CREATE TABLE core_operation_receipts(owner_id TEXT, operation_id TEXT, fingerprint TEXT, method TEXT, result_json TEXT, created_at TEXT, PRIMARY KEY(owner_id,operation_id))')
  const core = new SqlDataRuntime(db as never, 'sqlite')
  let contents = '', count = 0, authorization = true, denyAfterApply = false, recoveries = 0, publications = 0, replays = 0
  const port = createDurableFileSkillManagementPort({ core,
    async authorize() { return authorization },
    adapter: {
      async recover() { recoveries++ },
      async prepare() {
        const before = contents
        return { async apply() { contents = '新内容'; count++; if (denyAfterApply) authorization = false; return { id: 'demo' } },
          async rollback() { contents = before }, async finalize() {} }
      },
      async published() { publications++ },
      async replayed() { replays++ },
    },
  })
  const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' }
  const scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.execute>[2]
  const input = { id: 'demo', body: '新内容' }
  const call = { id: 'call-1', name: 'update_skill', input }
  try {
    const first = await port.execute('update', input, scope, call)
    expect(first).toMatchObject({ kind: 'completed', successful: true, mutated: true, value: { id: 'demo' } })
    expect(await port.execute('update', input, scope, call)).toMatchObject({ kind: 'completed', successful: true, mutated: false })
    expect([count, recoveries, publications, replays]).toEqual([1, 1, 1, 1])
    const changed = { id: 'demo', body: '另一内容' }
    expect(await port.execute('update', changed, scope, { ...call, input: changed })).toMatchObject({ kind: 'completed', successful: false })
    expect(count).toBe(1)
    contents = '原内容'
    denyAfterApply = true
    expect(await port.execute('update', input, scope, { ...call, id: 'call-2' })).toMatchObject({ kind: 'completed', successful: false })
    expect(contents).toBe('原内容')
    expect(file.prepare('SELECT count(*) AS n FROM core_operation_receipts').get()).toEqual({ n: 1 })
  } finally { await core.close() }
})

it('Agent 编辑文件技能保留厂商元数据并校验新关联工具', async () => {
  const { createAgentSkillDocument, updateAgentSkillDocument } = await import('../../../src/agent/tools/skill-management/file-document.js')
  const original = '---\nname: 原名称\ndescription: 描述\nmetadata:\n  vendor:\n    requires: [git]\n---\n原正文\n'
  const result = updateAgentSkillDocument(original, { id: 'demo', skill_name: '新名称', related_tools: ['read_file'] }, new Set(['read_file']))
  expect(parseSkillDocument(result)).toMatchObject({ name: '新名称', body: '原正文\n',
    metadata: { metadata: { vendor: { requires: ['git'] }, gugu: { related_tools: ['read_file'] } } } })
  expect(() => updateAgentSkillDocument(original, { id: 'demo', related_tools: ['unknown'] }, new Set())).toThrow('未知工具')
  const created = createAgentSkillDocument({ skill_name: '示例', description_short: '描述', body: '正文', related_tools: [], managed_by: 'assistant' }, new Set())
  expect(parseSkillDocument(created).metadata).toMatchObject({ metadata: { gugu: { managed_by: 'assistant' } } })
})

it('收据提交结果未知时先恢复文件，再重试同一技能操作', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect } = await import('kysely')
  const { SqlDataRuntime } = await import('../../../src/data/runtime.js')
  const { createDurableFileSkillManagementPort } = await import('../../../src/agent/tools/skill-management/file-port.js')
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  file.exec(`CREATE TABLE core_operation_receipts(owner_id TEXT, operation_id TEXT, fingerprint TEXT, method TEXT, result_json TEXT, created_at TEXT, PRIMARY KEY(owner_id,operation_id));
    CREATE TRIGGER reject_receipt BEFORE INSERT ON core_operation_receipts BEGIN SELECT RAISE(ABORT, '合成错误'); END;`)
  const core = new SqlDataRuntime(db as never, 'sqlite')
  let contents = '原内容', pending = false, applied = 0
  const port = createDurableFileSkillManagementPort({ core, async authorize() { return true }, adapter: {
    async recover() { if (pending) { contents = '原内容'; pending = false } },
    async prepare() { return { async apply() { pending = true; contents = '新内容'; applied++; return { id: 'demo' } },
      async rollback() { pending = false; contents = '原内容' }, async finalize() { pending = false } } },
    async published() {},
  } })
  const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' }
  const scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.execute>[2]
  const input = { id: 'demo', body: '新内容' }, call = { id: 'call', name: 'update_skill', input }
  try {
    expect(await port.execute('update', input, scope, call)).toEqual({ kind: 'unknown' })
    expect([contents, pending, applied]).toEqual(['新内容', true, 1])
    file.exec('DROP TRIGGER reject_receipt')
    expect(await port.execute('update', input, scope, call)).toMatchObject({ kind: 'completed', successful: true })
    expect([contents, pending, applied]).toEqual(['新内容', false, 2])
    expect(await port.execute('update', input, scope, call)).toMatchObject({ kind: 'completed', successful: true, mutated: false })
    expect(applied).toBe(2)
  } finally { await core.close() }
})

it('本地 Agent 技能文件事务支持创建、更新及提交失败后的恢复', async () => {
  const { default: SQLite } = await import('better-sqlite3')
  const { Kysely, SqliteDialect, sql } = await import('kysely')
  const { SqlDataRuntime } = await import('../../../src/data/runtime.js')
  const { createDurableFileSkillManagementPort } = await import('../../../src/agent/tools/skill-management/file-port.js')
  const { createLocalAgentSkillMutationAdapter } = await import('../../../src/agent/tools/skill-management/file-storage.js')
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-skill-files-'))
  const file = new SQLite(':memory:')
  const db = new Kysely({ dialect: new SqliteDialect({ database: file }) })
  file.exec(`CREATE TABLE core_operation_receipts(owner_id TEXT, operation_id TEXT, fingerprint TEXT, method TEXT, result_json TEXT, created_at TEXT, PRIMARY KEY(owner_id,operation_id));
    CREATE TABLE history(id TEXT, action TEXT, slug TEXT, before TEXT, after TEXT);`)
  const core = new SqlDataRuntime(db as never, 'sqlite')
  const adapter = createLocalAgentSkillMutationAdapter({ dataRoot: root, async lock() {}, async knownTools() { return new Set(['read_file']) },
    async record(tx, record) { await sql`INSERT INTO history VALUES(${record.operationId},${record.action},${record.slug},${record.before},${record.after})`.execute(tx) },
    async publish() {} })
  const port = createDurableFileSkillManagementPort({ core, adapter, async authorize() { return true } })
  const identity = { ownerId: '00000000-0000-4000-8000-000000000001', sessionId: '1', runId: 'run' }
  const scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.execute>[2]
  const input = { skill_name: '示例', description_short: '描述', body: '初版', related_tools: ['read_file'], managed_by: 'assistant' as const }
  const call = { id: 'create', name: 'create_skill', input }
  try {
    const created = await port.execute('create', input, scope, call)
    expect(created.kind).toBe('completed')
    if (created.kind !== 'completed') throw new Error('未创建')
    const id = (created.value as { skill: { id: string } }).skill.id
    expect((await readUserSkillBundle(root, identity.ownerId, id)).body).toBe('初版')
    expect(await port.execute('create', input, scope, call)).toMatchObject({ kind: 'completed', mutated: false })
    file.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON core_operation_receipts BEGIN SELECT RAISE(ABORT, '合成错误'); END;")
    const update = { id, body: '新版' }, updateCall = { id: 'update', name: 'update_skill', input: update }
    expect(await port.execute('update', update, scope, updateCall)).toEqual({ kind: 'unknown' })
    expect((await readUserSkillBundle(root, identity.ownerId, id)).body).toBe('新版')
    file.exec('DROP TRIGGER reject_receipt')
    expect(await port.execute('update', update, scope, updateCall)).toMatchObject({ kind: 'completed', successful: true })
    expect((await readUserSkillBundle(root, identity.ownerId, id)).body).toBe('新版')
    expect(file.prepare('SELECT action FROM history ORDER BY rowid').all()).toEqual([{ action: 'install' }, { action: 'update' }])
    file.exec("CREATE TRIGGER reject_receipt_again BEFORE INSERT ON core_operation_receipts BEGIN SELECT RAISE(ABORT, '合成错误'); END;")
    const update2 = { id, body: '待恢复版本' }, call2 = { id: 'update-2', name: 'update_skill', input: update2 }
    expect(await port.execute('update', update2, scope, call2)).toEqual({ kind: 'unknown' })
    const entry = join(root, identity.ownerId, '.agent', 'skills', id, 'SKILL.md')
    await writeFile(entry, '---\nname: 用户修改\ndescription: 描述\n---\n用户的新正文')
    file.exec('DROP TRIGGER reject_receipt_again')
    expect(await port.execute('update', update2, scope, call2)).toMatchObject({ kind: 'completed', successful: false })
    expect((await readUserSkillBundle(root, identity.ownerId, id)).body).toBe('用户的新正文')
  } finally { await core.close(); await rm(root, { recursive: true, force: true }) }
})
