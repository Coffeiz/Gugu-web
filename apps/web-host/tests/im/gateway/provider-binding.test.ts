import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { Pool } from 'pg'
import { contextAccessScopeHash, stableJson } from '@gugu/core/agent'
import { resolveImAccess, resolveImActor, type ImActor, type ImBotAccess } from '@gugu/core/im/access'
import { agentContextAccessScope } from '../../../src/modules/agent/model-config/access-scope.js'
import { encryptByokEnvelope, type ByokCredential } from '../../../src/modules/agent/model-config/byok.js'
import { readConfiguredAgentProviderSettings } from '../../../src/modules/agent/model-config/configured-provider-settings.js'
import { createConfiguredImAgentProviderBinding, freezeImAgentProviderScope } from '../../../src/modules/im/gateway/provider-binding.js'

const owner = '00000000-0000-4000-8000-000000000091'
const identity = { ownerId: owner, sessionId: '1', runId: 'synthetic-run' }
const bot: ImBotAccess = { ownerId: owner, id: '91', platform: 'telegram', ownerPlatformUserId: 'synthetic-owner',
  groupAllowedTools: ['web_search', 'group_context_search'], groupOwnerMemoryEnabled: true }
const actor = (patch: Partial<Parameters<typeof resolveImActor>[0]> = {}): ImActor => resolveImActor({ ownerId: owner, botId: '91',
  platform: 'telegram', platformUserId: 'synthetic-owner', chatType: 'c2c', chatId: null, botMentioned: false, mentionsOtherBot: false, ...patch },
scope => resolveImAccess(scope, bot))
const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')
const revisions = { model: 'synthetic-model-revision', credentials: 'synthetic-credential-revision', permissions: 'synthetic-policy' }
const hash = (scope: ReturnType<typeof freezeImAgentProviderScope>) => agentContextAccessScope('synthetic-secret', identity, scope, revisions, digest, scope.contextBinding)
const posix = ['linux', 'darwin'].includes(process.platform)
const posixOnly = { skip: !posix && '生产原子文件边界需要 POSIX flock 和 Node26；不以测试锁替代真实文件锁' }

test('IM 模型 scope 同时进入 Provider 与 Node 上下文，隔离群/私聊、Bot、平台和 actor 权限', () => {
  const original = freezeImAgentProviderScope(identity, actor(), bot, true), version = hash(original)
  assert.equal(contextAccessScopeHash(identity, { ...original, contextScopeKey: version.contextScopeKey }, digest), version.accessScopeHash)
  assert.equal(original.groupChat, false)
  assert.equal(original.contextPolicy.loadOwnerContext, true)
  const group = actor({ chatType: 'group', chatId: 'synthetic-group', platformUserId: 'synthetic-member' })
  const scopedGroup = freezeImAgentProviderScope(identity, group, bot, true)
  assert.equal(scopedGroup.groupChat, true)
  assert.equal(scopedGroup.contextPolicy.loadOwnerContext, false)
  const variants = [scopedGroup,
    freezeImAgentProviderScope(identity, { ...group, chatId: 'another-group' }, bot, true),
    freezeImAgentProviderScope(identity, { ...group, platformUserId: 'another-member' }, bot, true),
    freezeImAgentProviderScope(identity, actor(), bot, false),
    freezeImAgentProviderScope(identity, { ...actor(), allowedToolNames: ['web_search'] }, bot, true),
    freezeImAgentProviderScope(identity, { ...actor(), botId: '92' }, { ...bot, id: '92' }, true),
    freezeImAgentProviderScope(identity, { ...actor(), platform: 'qq' }, { ...bot, platform: 'qq' }, true),
  ]
  for (const scope of variants) assert.notEqual(hash(scope).contextScopeKey, version.contextScopeKey)
  assert.doesNotMatch(JSON.stringify(version), /synthetic-owner|synthetic-secret|synthetic-model-revision/)
  assert.notEqual(hash(freezeImAgentProviderScope(identity, group, { ...bot, groupOwnerMemoryEnabled: false }, true)).contextScopeKey,
    hash(scopedGroup).contextScopeKey)
})

test('scope 校验 owner/Bot/群身份且冻结输入，权限数组顺序不改变语义', () => {
  for (const [who, config] of [[{ ...actor(), ownerId: 'other' }, bot], [actor(), { ...bot, id: '92' }],
    [{ ...actor(), chatType: 'group' as const, chatId: null }, bot]] as const)
    assert.throws(() => freezeImAgentProviderScope(identity, who, config, true), /身份或策略无效/)
  const mutable = { ...actor(), allowedToolNames: ['web_search', 'http_get'] }
  const before = freezeImAgentProviderScope(identity, mutable, bot, true), beforeHash = hash(before)
  mutable.allowedToolNames.reverse()
  assert.deepEqual(hash(freezeImAgentProviderScope(identity, mutable, bot, true)), beforeHash)
  mutable.allowedToolNames.push('read_file')
  assert.deepEqual(hash(before), beforeHash)
  assert.notEqual(hash(freezeImAgentProviderScope(identity, mutable, bot, true)).contextScopeKey, beforeHash.contextScopeKey)
  assert.equal(Object.isFrozen(before.contextPolicy), true)
})

async function temporary(work: (paths: { directory: string; promptRoot: string; configPath: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-im-provider-')), promptRoot = join(directory, 'prompts'), configPath = join(directory, 'config.override.json')
  try {
    await mkdir(promptRoot)
    for (const name of ['default.md', 'persona.md', 'skills.md', 'policy.md', 'retrieval.md']) await writeFile(join(promptRoot, name), `合成提示词 ${name}`)
    await writeFile(configPath, JSON.stringify({ ai: { provider: 'openai', model: 'synthetic-model-a', api_format: 'openai',
      api_key: 'synthetic-platform-token', base_url: 'https://provider.example.test', context_tokens: 8192 } }))
    await work({ directory, promptRoot, configPath })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function credential(): ByokCredential {
  const envelope = encryptByokEnvelope('synthetic-byok-token', 'synthetic-master', 1)
  return { provider: 'openai', api_format: 'openai', base_url: 'https://byok.example.test', model: 'synthetic-byok-model',
    encrypted_value: envelope.ciphertext, nonce: envelope.nonce, encrypted_data_key: envelope.encryptedDataKey, key_version: 1,
    max_tokens: null, context_tokens: 4096, thinking: null, reasoning_effort: null, reasoning_persistence: 'off',
    image: false, video: false, audio: false, image_detail: 'auto', web_search_enabled: false }
}
/** 仅 PG repeatable-read 协议的可控替身；无真实 PG、Provider 或平台请求。 */
function database(row: ByokCredential | null = null) {
  const statements: string[] = [], owners: unknown[] = []
  const client = { async query(sql: string, params?: unknown[]) { statements.push(sql)
    if (sql.includes('FROM user_provider_credentials')) { owners.push(params?.[0]); return { rows: row ? [{ id: 1, ...row }] : [], rowCount: row ? 1 : 0 } }
    return { rows: [], rowCount: 0 }
  }, release() {} }
  return { pool: { async connect() { return client } } as unknown as Pick<Pool, 'connect'>, statements, owners }
}
const environment = () => ({ BYOK__ENABLED: 'true', CREDENTIALS_MASTER_KEY: 'synthetic-master' })

test('共享配置实际读取固定提示词与 BYOK 环境主密钥，解封合成凭据', async () => temporary(async paths => {
  const configured = await readConfiguredAgentProviderSettings({ ...paths, environment: environment(), permissionIdentity: 'synthetic-policy' })
  const effective = configured.resolveEffective({ ai: { model: 'synthetic-model', context_tokens: 8192 } }, identity)
  for (const file of ['default.md', 'persona.md', 'skills.md', 'policy.md', 'retrieval.md']) assert.ok(effective.systemPrompt.includes(file))
  assert.equal(configured.decryptCredential(credential()), 'synthetic-byok-token')
  assert.equal(effective.versionMaterial.permissionIdentity, 'synthetic-policy')
}))

test('临时配置→真实原子快照→BYOK绑定，调度版本与 bindRun 同域且可恢复原模型', posixOnly, async () => temporary(async paths => {
  const db = database(credential()), binding = await createConfiguredImAgentProviderBinding({ ...paths, ...db,
    environment: environment(), permissionIdentity: 'synthetic-policy', versionSecret: 'synthetic-secret', defaultLimit6h: 0 })
  const version = await binding.accessVersion(identity, actor(), bot, true)
  const initial = await binding.bindRun(identity, actor(), bot, true, 'en-US')
  assert.equal(initial.selection.contextScopeKey, version)
  const provider = await initial.resolve(identity, initial.selection.modelIdentity, new AbortController().signal)
  assert.equal(provider.config.api_key, 'synthetic-byok-token')
  assert.equal(provider.config.base_url, 'https://byok.example.test')
  assert.equal(provider.config.model, 'synthetic-byok-model')
  assert.equal(initial.selection.contextWindow, 4096)
  assert.equal(initial.usageConfig.isByok, true)
  assert.equal(provider.accessScopeHash, contextAccessScopeHash(identity, initial.selection, digest))
  const recovery = { identity, modelIdentity: initial.selection.modelIdentity, accessScopeHash: provider.accessScopeHash }
  const resumed = await binding.bindRun(identity, actor(), bot, true, 'en-US', recovery)
  assert.equal(resumed.selection.modelIdentity, initial.selection.modelIdentity)
  assert.equal(resumed.selection.contextScopeKey, version)
  assert.ok(db.statements.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'))
  assert.ok(db.statements.includes('COMMIT'))
  assert.ok(db.owners.every(value => value === owner))
  await assert.rejects(binding.bindRun(identity, actor(), bot, false, 'en-US', recovery), /配置或访问范围已变化/)
  await assert.rejects(initial.resolve({ ...identity, ownerId: 'another' }, initial.selection.modelIdentity, new AbortController().signal), /模型访问身份不匹配/)
  assert.doesNotMatch(JSON.stringify([version, initial.selection.modelIdentity]), /synthetic-byok-token|synthetic-platform-token|synthetic-master/)
  initial.release(); initial.release(); resumed.release()
}))

test('群成员不加载 owner 上下文，模型配置与权限变更后不重新选择恢复模型', posixOnly, async () => temporary(async paths => {
  const binding = await createConfiguredImAgentProviderBinding({ ...paths, pool: database().pool,
    environment: environment(), permissionIdentity: 'synthetic-policy', versionSecret: 'synthetic-secret', defaultLimit6h: null })
  const member = actor({ chatType: 'group', chatId: 'synthetic-group', platformUserId: 'synthetic-member' })
  const initial = await binding.bindRun(identity, member, bot, true, null)
  assert.equal(initial.selection.groupChat, true)
  assert.equal(initial.selection.contextPolicy.loadOwnerContext, false)
  const provider = await initial.resolve(identity, initial.selection.modelIdentity, new AbortController().signal)
  const recovery = { identity, modelIdentity: initial.selection.modelIdentity, accessScopeHash: provider.accessScopeHash }
  const version = await binding.accessVersion(identity, member, bot, true)
  assert.equal(initial.selection.contextScopeKey, version)
  await assert.rejects(binding.bindRun(identity, { ...member, allowedToolNames: ['web_search'] }, bot, true, null, recovery), /配置或访问范围已变化/)
  await writeFile(paths.configPath, JSON.stringify({ ai: { provider: 'openai', model: 'synthetic-model-b', context_tokens: 8192 } }))
  assert.notEqual(await binding.accessVersion(identity, member, bot, true), version)
  await assert.rejects(binding.bindRun(identity, member, bot, true, null, recovery), /配置或访问范围已变化/)
  initial.release()
}))
