import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import type { ContextSourceSelection, Json } from '@gugu/core/agent'
import { resolveImActor } from '@gugu/core/im/access'
import { createImAgentContextServices, ImContextServicesError } from '../../../src/modules/im/gateway/context-services.js'

const owner = '00000000-0000-4000-8000-000000000091'
const identity = { ownerId: owner, sessionId: '91', runId: 'synthetic-run' }
const now = () => Date.parse('2026-11-17T00:00:00Z')
const actor = (group = false, member = false) => resolveImActor({ ownerId: owner, botId: '91', platform: 'telegram',
  chatType: group ? 'group' : 'c2c', chatId: group ? 'synthetic-group' : null, platformUserId: 'synthetic-speaker',
  botMentioned: true, mentionsOtherBot: false }, () => ({ role: member ? 'member' : 'owner', allowedToolNames: member ? [] : null }))
const selection = (group = false, member = false): ContextSourceSelection => ({ modelIdentity: 'synthetic-model', contextWindow: 8192,
  locale: 'zh-CN', groupChat: group, workspaceBinding: null, contextScopeKey: 'synthetic-scope',
  contextPolicy: { loadOwnerContext: !member, memoryEnabled: true } })
const code = (expected: ImContextServicesError['code']) => (error: unknown) => {
  assert.ok(error instanceof ImContextServicesError)
  assert.equal(error.code, expected)
  assert.equal(error.message, 'IM 上下文服务不可用')
  assert.equal(error.cause, undefined)
  return true
}

async function fixture(work: (f: Awaited<ReturnType<typeof temporary>>) => Promise<void>) {
  const f = await temporary()
  try { await work(f) } finally { await rm(f.directory, { recursive: true, force: true }) }
}
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-context-')), promptRoot = join(directory, 'prompts'), storageRoot = join(directory, 'storage')
  await mkdir(join(promptRoot, 'im'), { recursive: true })
  await mkdir(join(storageRoot, owner, '.agent', 'prompt'), { recursive: true })
  for (const name of ['default', 'persona', 'skills', 'policy', 'retrieval', 'compress_conv']) await writeFile(join(promptRoot, `${name}.md`), `合成固定提示词 ${name}`)
  await writeFile(join(promptRoot, 'im', 'group_chat.md'), '合成群规则')
  const preferences = { personality_preference_enabled: true, group_personality_preference_enabled: true,
    custom_reply_style_enabled: true, locale: 'ja-JP', personality_preference_revision: 8 }
  let raw: string | null = JSON.stringify(preferences), allowed = true, afterQuery: (() => void) | undefined
  const queries: { sql: string; values?: unknown[] }[] = []
  // 仅数据库查询的受控替身；偏好/固定提示词由真实临时文件读取，不调用平台或Provider。
  const pool = { async query(sql: string, values?: unknown[]) {
    queries.push({ sql, values })
    let rows: Record<string, unknown>[]
    if (sql.includes('SELECT u.timezone,p.data_json')) rows = [{ timezone: 'Asia/Tokyo', data_json: raw }]
    else if (sql.includes('SELECT p.data_json')) rows = [{ data_json: raw }]
    else if (sql.includes('SELECT b.platform')) rows = [{ platform: 'telegram' }]
    else if (sql.startsWith('SELECT 1 FROM conversation_sessions')) rows = [{}]
    else if (sql.includes('FROM calendar_events')) rows = [{ date: '2026-11-18', title: '合成事件' }]
    else throw new Error('合成未覆盖SQL')
    afterQuery?.()
    return { rows, rowCount: rows.length }
  } } as unknown as Pick<Pool, 'query'>
  let catalogCalls = 0
  const options = { pool, storageRoot, promptRoot, identity, actor: actor(), selection: selection(), now,
    redis: { async get(key: string) { return key.startsWith('context-revision:') ? '13' : null } }, serverTimezone: 'UTC',
    async authorize() { return allowed }, async imMemory(): Promise<Json> { return { group: { summary: '合成群摘要' }, platform_user: { profile: '合成个人资料' } } },
    platformEnabled: (platform: string) => platform === 'telegram',
    async skillCatalog() { catalogCalls++; return [{ id: 'synthetic-skill', name: '合成技能', description: '真实授权目录返回' }] },
    systemInMessages: () => true }
  return { directory, promptRoot, storageRoot, options, queries,
    setRaw(value: string | null) { raw = value }, setAllowed(value: boolean) { allowed = value },
    afterQuery(callback: () => void) { afterQuery = callback }, catalogCalls: () => catalogCalls,
    async preference(name: string, text: string) { await writeFile(join(storageRoot, owner, '.agent', 'prompt', name), text) } }
}

test('实际偏好文件、拥有者SQL概览、时区、修订和授权技能目录进入IM上下文', async () => fixture(async f => {
  await f.preference('persona.md', '合成私人人格')
  await f.preference('reply-style.md', '合成回复风格')
  const services = await createImAgentContextServices(f.options)
  const styles = await services.source.data.loadStylePreferences(identity)
  const prompt = services.builder.staticPrompt(f.options.selection, identity, styles)
  assert.equal(prompt.personalityPreference, '合成私人人格')
  assert.equal(prompt.personalityPreferenceEnabled, true)
  assert.equal(prompt.customReplyStyle, '合成回复风格')
  assert.equal(prompt.locale, 'ja-JP')
  assert.equal(prompt.timezone, 'Asia/Tokyo')
  assert.match(prompt.skillIndex, /合成技能/)
  assert.equal(f.catalogCalls(), 1)
  assert.equal(await services.source.currentRevision(identity), 13)
  assert.deepEqual(await services.source.data.loadEvents(identity, 'Asia/Tokyo'), [{ date: '2026-11-18', title: '合成事件' }])
  assert.deepEqual(await services.source.data.loadImChannels(identity), { telegram: true, feishu: false, qq: false, wechat: false })
  assert.equal(services.compactionInstruction, '合成固定提示词 compress_conv')
  assert.equal(services.builder.systemInMessages(f.options.selection), true)
  assert.equal(f.queries.every(query => query.values?.includes(owner)), true)
  assert.equal(f.queries.filter(query => query.sql.includes('FROM conversation_sessions')).every(query => query.values?.includes(identity.sessionId)), true)
  const request = await services.prepareRequest(identity, new AbortController().signal)
  assert.match(JSON.stringify(request.dynamicTail), /2026-11-17/)
  assert.deepEqual(request.prefix, [])
}))

test('群人格独立于私人人格，读取当前群配置与真实文件，不硬编码关闭', async () => fixture(async f => {
  await f.preference('persona.md', '不应进入群的私人人格')
  await f.preference('group-persona.md', '合成群人格')
  await f.preference('reply-style.md', '合成群回复风格')
  const config = { ...f.options, actor: actor(true), selection: selection(true) }
  const services = await createImAgentContextServices(config)
  const styles = await services.source.data.loadStylePreferences(identity)
  const prompt = services.builder.staticPrompt(config.selection, identity, styles)
  assert.equal(prompt.groupPersonalityPreferenceEnabled, true)
  assert.equal(prompt.groupPersonalityPreference, '合成群人格')
  assert.equal(prompt.customReplyStyle, '合成群回复风格')
  assert.equal(prompt.personalityPreference, undefined)
  assert.equal(prompt.afterBasePrompt, '合成群规则')
  f.setRaw(JSON.stringify({ group_personality_preference_enabled: false }))
  const disabled = await services.source.data.loadStylePreferences(identity)
  assert.equal(services.builder.staticPrompt(config.selection, identity, disabled).groupPersonalityPreferenceEnabled, false)
}))

test('成员不读取owner业务/私人人格，但真实群人格进入静态system；个人记忆仅进入当前动态尾部', async () => fixture(async f => {
  await f.preference('persona.md', '不应公开的私人人格')
  await f.preference('group-persona.md', '成员也应看到的群人格')
  await f.preference('reply-style.md', '合成群回复风格')
  const config = { ...f.options, actor: actor(true, true), selection: selection(true, true) }
  const services = await createImAgentContextServices(config)
  // use_skill是固定入口，技能可见性由必填的授权目录服务裁剪，不能据此取得owner资料。
  assert.equal(f.catalogCalls(), 1)
  for (const load of [services.source.data.loadStylePreferences, services.source.data.loadProjects, services.source.data.loadNotes,
    services.source.data.loadFilesOverview, services.source.data.loadImChannels, services.source.data.loadKnowledge, services.source.data.loadMemory])
    await assert.rejects(load(identity), code('unauthorized'))
  const prompt = services.builder.staticPrompt(config.selection, identity, { personality_preference: '不可信owner资料', personality_preference_enabled: true })
  assert.equal(prompt.personalityPreference, undefined)
  assert.equal(prompt.groupPersonalityPreference, '成员也应看到的群人格')
  assert.equal(prompt.groupPersonalityPreferenceEnabled, true)
  assert.equal(prompt.customReplyStyle, '合成群回复风格')
  assert.equal(prompt.locale, 'ja-JP')
  const prepared = await services.prepareRequest(identity, new AbortController().signal)
  assert.match(JSON.stringify(prepared.dynamicTail), /合成个人资料/)
  assert.doesNotMatch(JSON.stringify(prepared.dynamicTail), /合成群摘要/)
  assert.equal(f.queries.every(query => query.sql.includes('SELECT u.timezone,p.data_json') || query.sql.includes('SELECT p.data_json')), true)
  const privateMember = await createImAgentContextServices({ ...f.options, actor: actor(false, true), selection: selection(false, true) })
  const privatePrompt = privateMember.builder.staticPrompt(selection(false, true), identity, { personality_preference: '不可信owner资料' })
  assert.equal(privatePrompt.personalityPreference, undefined)
  assert.equal(privatePrompt.groupPersonalityPreference, undefined)
}))

test('受限群system加载期间撤权或群配置损坏时不装配半成品资源', async () => fixture(async f => {
  const config = { ...f.options, actor: actor(true, true), selection: selection(true, true) }
  f.setRaw('{合成损坏群配置')
  await assert.rejects(createImAgentContextServices(config), code('invalid_data'))
  f.setRaw('{}')
  f.afterQuery(() => f.setAllowed(false))
  await assert.rejects(createImAgentContextServices(config), code('unauthorized'))
}))

test('读取过程中撤销权限不返回刚取得的数据；身份与模型scope不可跨Run复用', async () => fixture(async f => {
  const services = await createImAgentContextServices(f.options)
  f.afterQuery(() => f.setAllowed(false))
  await assert.rejects(services.source.data.loadTimezone(identity), code('unauthorized'))
  f.setAllowed(true)
  await assert.rejects(services.source.data.loadTimezone({ ...identity, ownerId: 'another-owner' }), code('invalid_scope'))
  await assert.rejects(services.prepareRequest({ ...identity, runId: 'another-run' }, new AbortController().signal), code('invalid_scope'))
  assert.throws(() => services.builder.staticPrompt({ ...f.options.selection, contextScopeKey: 'another-scope' }, identity, {}), code('invalid_scope'))
  assert.throws(() => services.builder.staticPrompt({ ...f.options.selection, modelIdentity: 'another-model' }, identity, {}), code('invalid_scope'))
}))

test('坏群配置/控制字符失败关闭，数据库原异常脱敏，取消与关闭owner记忆不会读取私有数据', async () => fixture(async f => {
  const services = await createImAgentContextServices({ ...f.options, actor: actor(true), selection: selection(true) })
  f.setRaw('{synthetic-private-invalid-json')
  await assert.rejects(services.source.data.loadStylePreferences(identity), code('invalid_data'))
  f.setRaw(JSON.stringify({ group_personality_preference_enabled: true }))
  await f.preference('group-persona.md', '合成\u0000坏文本')
  await assert.rejects(services.source.data.loadStylePreferences(identity), code('invalid_data'))
  const controller = new AbortController(); controller.abort(new Error('synthetic-private-cancellation'))
  await assert.rejects(services.source.data.loadTimezone(identity, controller.signal), code('aborted'))
  const disabled = await createImAgentContextServices({ ...f.options, selection: { ...f.options.selection,
    contextPolicy: { ...f.options.selection.contextPolicy, memoryEnabled: false } } })
  await assert.rejects(disabled.source.data.loadMemory(identity), code('unauthorized'))
  await assert.rejects(createImAgentContextServices({ ...f.options, pool: { async query() { throw new Error('synthetic-private-db-password') } } as unknown as Pick<Pool, 'query'> }), code('unavailable'))
}))

test('真实缺省偏好与不存在本地知识允许为空；缺少固定提示词或可信依赖拒绝装配', async () => fixture(async f => {
  f.setRaw(null)
  const services = await createImAgentContextServices(f.options)
  assert.deepEqual(await services.source.data.loadStylePreferences(identity), {})
  assert.deepEqual(await services.source.data.loadKnowledge(identity), [])
  await rm(join(f.promptRoot, 'compress_conv.md'))
  await assert.rejects(createImAgentContextServices(f.options), code('unavailable'))
  await assert.rejects(createImAgentContextServices({ ...f.options, actor: { ...f.options.actor, chatType: 'group', chatId: null } }), code('invalid_scope'))
}))
