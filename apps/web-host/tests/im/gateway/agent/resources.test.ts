import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
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
  const resources = await createImProductionSkills({ pool, identity, actor, loadOwnerContext: false, authorize: async () => true })
  const skills = await resources.registry.catalog(identity)
  assert.deepEqual(skills.map(skill => skill.id), skills.map((_, index) => `S${index + 1}`))
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

test('生产Skill资源使用真实PG元数据与按需正文：跨用户隔离、成员不可读取owner技能、停用后即时撤权', {
  skip: !(databaseUrl && python) && '需显式隔离PG及只读ORM编译解释器', timeout: 120000,
}, async () => {
  const f = await createImProductionFixture({ python: python!, databaseUrl })
  try {
    const identity = { ownerId: f.ownerId, sessionId: '1', runId: randomUUID() }
    const input = { ownerId: f.ownerId, botId: f.botId, platform: 'telegram' as const,
      chatType: 'c2c' as const, chatId: null, platformUserId: '202', botMentioned: false, mentionsOtherBot: false }
    const access = createPostgresImAccess({ query: (sql, values) => f.pool.query(sql, values), supportedPlatforms: () => ['telegram'] })
    const snapshot = await access.snapshot(input), actor = snapshot.actor(input)
    for (const [ownerId, body] of [[f.ownerId, '仅当前owner正文'], [f.otherOwnerId, '禁止跨用户正文']]) {
      await f.insert('user_skills', { owner_id: ownerId, skill_id: 'U1', name: '合成技能', description_short: '合成摘要',
        body, enabled: true, source: 'user', content_digest: 'a'.repeat(64), related_tools: [] })
    }
    const resources = await createImProductionSkills({ pool: f.pool, identity, actor, loadOwnerContext: true,
      authorize: () => access.authorizeDelivery(actor, snapshot.bot) })
    assert.ok((await resources.registry.catalog(identity)).some(item => item.id === 'U1'))
    const loaded = await resources.registry.load('U1', identity, new AbortController().signal)
    assert.equal(loaded.content, '仅当前owner正文')
    assert.ok(!JSON.stringify(await resources.registry.catalog(identity)).includes(loaded.content))
    assert.deepEqual(await resources.registry.catalog({ ...identity, ownerId: f.otherOwnerId }), [])
    await assert.rejects(resources.registry.load('U1', { ...identity, sessionId: '2' }, new AbortController().signal))

    const member = { ...actor, role: 'member' as const, verifiedOwner: false, allowedToolNames: ['use_skill'] }
    const restricted = await createImProductionSkills({ pool: f.pool, identity, actor: member, loadOwnerContext: false,
      authorize: () => access.authorizeDelivery(actor, snapshot.bot) })
    assert.ok(!(await restricted.registry.catalog(identity)).some(item => item.id === 'U1'))
    await assert.rejects(restricted.registry.load('U1', identity, new AbortController().signal))
    await f.pool.query('UPDATE user_skills SET enabled=false WHERE owner_id=$1 AND skill_id=$2', [f.ownerId, 'U1'])
    await assert.rejects(resources.registry.load('U1', identity, new AbortController().signal))
    await f.pool.query('UPDATE user_bots SET enabled=false WHERE user_id=$1 AND id=$2', [f.ownerId, f.botId])
    assert.deepEqual(await resources.registry.catalog(identity), [])
  } finally { await f.close() }
})
