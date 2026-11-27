import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserSkillBundle, patchSkillDocument } from '@gugu/core/skills'
import { test } from 'node:test'
import { createBuiltinSkillDefinitions } from '@gugu/core/skills'
import { createBundledSkillDocuments } from '@gugu/core/skills/bundled'
import { createPostgresImAccess } from '../../../../src/modules/im/gateway/inbound/access.js'
import { createImProductionSkills } from '../../../../src/modules/im/gateway/agent/skills.js'
import { createImProductionFixture } from '../production.fixtures.js'

const databaseUrl = process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
const python = process.env.GUGU_IM_FIXTURE_PYTHON

test('IM 简介模式仅列出当前群聊已开放的工具，全量模式省略重复目录', async () => {
  const identity = { ownerId: 'owner', sessionId: '1', runId: 'run' }
  const actor = { ownerId: identity.ownerId, botId: '1', platform: 'qq' as const,
    chatType: 'group' as const, chatId: 'group', platformUserId: 'member', role: 'member' as const,
    verifiedOwner: false, ownerMentionAuthorized: false, speakerRoles: null, allowedToolNames: ['web_search', 'use_skill'] }
  let mode = 'description'
  const pool = {
    async query() { return { rows: [{ data_json: { tool_injection_mode: mode } }] } },
  } as unknown as Parameters<typeof createImProductionSkills>[0]['pool']
  const available = new Set(['use_skill'])
  const resources = await createImProductionSkills({ pool, identity, actor, loadOwnerContext: false,
    authorize: async () => true, availableTools: async () => available })
  const skills = await resources.registry.catalog(identity)
  const builtins = await createBuiltinSkillDefinitions(createBundledSkillDocuments(), new AbortController().signal)
  const weather = builtins.find(skill => skill.key === 'weather')
  assert.ok(weather)
  assert.ok(!skills.some(skill => skill.id === weather.id))
  await assert.rejects(resources.registry.load(weather.id, identity, new AbortController().signal), { code: 'unavailable' })
  available.add('http_get')
  assert.ok((await resources.registry.catalog(identity)).some(skill => skill.id === weather.id))
  available.delete('http_get')
  await assert.rejects(resources.registry.load(weather.id, identity, new AbortController().signal), { code: 'unavailable' })
  const chart = skills.find(skill => skill.key === 'chart-and-math')
  assert.ok(chart)
  assert.match((await resources.registry.load(chart.id, identity, new AbortController().signal)).content, /Mermaid/u)
  const subject = { ownerId: identity.ownerId, workspaceId: null, subject: { kind: 'session' as const, id: identity.sessionId } }
  const names = ['web_search', 'list_projects']
  const tools = names.map(name => ({ name, schema: { function: { description: '查询公开信息。后续细节。',
    parameters: { type: 'object', required: ['query'], properties: {
      query: { type: 'string' }, mode: { type: 'string', enum: ['quick', 'deep'] },
      filters: { type: 'array', items: { type: 'object', properties: { days: { type: 'integer' } } } },
    } },
  } } }))
  const brief = await resources.catalog(names, subject, tools)
  assert.match(brief?.toolCatalog ?? '', /`web_search`：查询公开信息。/u)
  assert.match(brief!.toolCatalog, /query\(string\),必填、mode\(string\[quick\|deep\]\)、filters\(array<object:days:integer>\)/u)
  assert.doesNotMatch(brief!.toolCatalog, /list_projects|后续细节/u)
  mode = 'full'
  const full = await resources.catalog(names, subject, tools)
  assert.equal(full?.metadataOnly, true)
  assert.equal(full.toolCatalog, '')
})

test('IM 私聊加载当前用户文件技能，停用后即时撤权且群聊隔离', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-im-skill-'))
  const ownerId = '00000000-0000-4000-8000-000000000001'
  const identity = { ownerId, sessionId: '1', runId: 'run' }
  const actor = { ownerId, botId: '1', platform: 'qq' as const, chatType: 'c2c' as const, chatId: null,
    platformUserId: 'owner', role: 'owner' as const, verifiedOwner: true, ownerMentionAuthorized: false,
    speakerRoles: null, allowedToolNames: ['use_skill'] }
  const pool = { async query() { return { rows: [] } } } as unknown as Parameters<typeof createImProductionSkills>[0]['pool']
  try {
    const original = '---\nname: 示例\ndescription: 描述\n---\n私有正文'
    await createUserSkillBundle(root, ownerId, 'demo', original)
    const resources = await createImProductionSkills({ pool, storageRoot: root, identity, actor, loadOwnerContext: true, authorize: async () => true })
    assert.ok((await resources.registry.catalog(identity)).some(item => item.id === 'demo' && item.path === '/workspace/.agent/skills/demo'))
    assert.equal((await resources.registry.load('demo', identity, new AbortController().signal)).content, '私有正文')
    assert.deepEqual(await resources.registry.catalog({ ...identity, ownerId: '00000000-0000-4000-8000-000000000002' }), [])
    const group = await createImProductionSkills({ pool, storageRoot: root, identity, actor: { ...actor, chatType: 'group', chatId: 'group' },
      loadOwnerContext: true, authorize: async () => true })
    assert.ok(!(await group.registry.catalog(identity)).some(item => item.id === 'demo'))
    await writeFile(join(root, ownerId, '.agent', 'skills', 'demo', 'SKILL.md'), patchSkillDocument(original, { enabled: false }))
    await assert.rejects(resources.registry.load('demo', identity, new AbortController().signal))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('生产文件技能使用真实 IM 授权与按需正文：跨用户隔离、成员不可读取owner技能、停用后即时撤权', {
  skip: !(databaseUrl && python) && '需显式隔离PG及只读ORM编译解释器', timeout: 120000,
}, async () => {
  const f = await createImProductionFixture({ python: python!, databaseUrl })
  const root = await mkdtemp(join(tmpdir(), 'gugu-im-skill-auth-'))
  try {
    const identity = { ownerId: f.ownerId, sessionId: '1', runId: randomUUID() }
    const input = { ownerId: f.ownerId, botId: f.botId, platform: 'telegram' as const,
      chatType: 'c2c' as const, chatId: null, platformUserId: '202', botMentioned: false, mentionsOtherBot: false }
    const access = createPostgresImAccess({ query: (sql, values) => f.pool.query(sql, values), supportedPlatforms: () => ['telegram'] })
    const snapshot = await access.snapshot(input), actor = snapshot.actor(input)
    for (const [ownerId, body] of [[f.ownerId, '仅当前owner正文'], [f.otherOwnerId, '禁止跨用户正文']]) {
      await createUserSkillBundle(root, ownerId, 'demo', '---\nname: 合成技能\ndescription: 合成摘要\n---\n' + body)
    }
    const resources = await createImProductionSkills({ pool: f.pool, storageRoot: root, identity, actor, loadOwnerContext: true,
      authorize: () => access.authorizeDelivery(actor, snapshot.bot) })
    assert.ok((await resources.registry.catalog(identity)).some(item => item.id === 'demo'))
    const loaded = await resources.registry.load('demo', identity, new AbortController().signal)
    assert.equal(loaded.content, '仅当前owner正文')
    assert.ok(!JSON.stringify(await resources.registry.catalog(identity)).includes(loaded.content))
    assert.deepEqual(await resources.registry.catalog({ ...identity, ownerId: f.otherOwnerId }), [])
    await assert.rejects(resources.registry.load('demo', { ...identity, sessionId: '2' }, new AbortController().signal))

    const member = { ...actor, role: 'member' as const, verifiedOwner: false, allowedToolNames: ['use_skill'] }
    const restricted = await createImProductionSkills({ pool: f.pool, storageRoot: root, identity, actor: member, loadOwnerContext: false,
      authorize: () => access.authorizeDelivery(actor, snapshot.bot) })
    assert.ok(!(await restricted.registry.catalog(identity)).some(item => item.id === 'demo'))
    await assert.rejects(restricted.registry.load('demo', identity, new AbortController().signal))
    const path = join(root, f.ownerId, '.agent', 'skills', 'demo', 'SKILL.md')
    await writeFile(path, patchSkillDocument('---\nname: 合成技能\ndescription: 合成摘要\n---\n仅当前owner正文', { enabled: false }))
    await assert.rejects(resources.registry.load('demo', identity, new AbortController().signal))
    await f.pool.query('UPDATE user_bots SET enabled=false WHERE user_id=$1 AND id=$2', [f.ownerId, f.botId])
    assert.deepEqual(await resources.registry.catalog(identity), [])
  } finally { await f.close(); await rm(root, { recursive: true, force: true }) }
})
