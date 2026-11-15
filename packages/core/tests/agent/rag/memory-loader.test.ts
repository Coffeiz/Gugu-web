import { describe, expect, it } from 'vitest'
import { Kysely, SqliteDialect, sql } from 'kysely'
import SQLite from 'better-sqlite3'
import { prepareMemory, type MemoryRagScopeStatePort, type MemoryRagStorageReader } from '../../../src/agent/rag/memory-loader.js'
import { createSqlMemoryScopeStateReader } from '../../../src/agent/rag/memory-scope-state.js'

const owner = 'f17421a3-8520-4c8b-92e5-736882f4bd82'
const ownerScopes = [{ type: 'owner' as const, id: owner, ownerId: owner }]

function memoryFileStore(files: Record<string, string>): MemoryRagStorageReader {
  return {
    async readText({ key }) { return Object.hasOwn(files, key) ? files[key]! : null },
  }
}

const noScopeState: MemoryRagScopeStatePort = {
  async getMemoryScopeState() { return { revision: '0:initial', tombstoned: false } },
}

describe('1.7.7 memory loader迁入Core', () => {
it('只读取 owner 索引，过滤异主文档并补入 daily；向量只接收匹配模型版本', async () => {
  const parent = 'memory:profile:profile:0'
  const result = await prepareMemory({
    ownerId: owner, scopes: ownerScopes, sourceFilter: 'all', snapshotRevision: '1', snapshotText: '', vectorVersion: 'provider:model:2',
  }, noScopeState, memoryFileStore({
    [`${owner}/.agent/rag/memory/index.json`]: JSON.stringify({ schema_version: 1, documents: [
      { document_id: parent, parent_document_id: parent, chunk_index: 0, chunk_count: 1, source_type: 'memory', source_id: 'profile', title: '用户画像', summary: '偏好咖啡', content: '偏好咖啡', version: 'profile-v1', scope: { owner_user_id: owner, scope_type: 'owner', scope_id: '' }, metadata: {} },
      { document_id: 'leak', parent_document_id: 'leak', chunk_index: 0, chunk_count: 1, source_type: 'memory', source_id: 'profile', title: '不应读取', content: '他人正文', version: 'v1', scope: { owner_user_id: '08a80873-5266-43b9-a27c-d288b602a9cb', scope_type: 'owner', scope_id: '' }, metadata: {} },
    ] }),
    [`${owner}/.agent/daily.md`]: '## 2026-09-12\n- 今天完成测试\n',
    [`${owner}/.agent/memory_vec.json`]: JSON.stringify({
      [`rag:${parent}:profile-v1:0`]: { t: 'provider:model:2', v: [0.25, 0.75] },
      stale: { t: 'old-model', v: [1] },
    }),
  }))
  expect(result.documents.map((document) => document.source_id)).toEqual(['profile', 'daily'])
  expect(result.documents[1]?.content).toBe('- 2026-09-12 今天完成测试')
  expect(result.vectors).toEqual({ [`memory:${parent}:0`]: [0.25, 0.75] })
})

it('空 pattern.json 不会从旧 facts 文件复活已删除的行为记忆', async () => {
  const result = await prepareMemory({
    ownerId: owner, scopes: ownerScopes, sourceFilter: 'pattern', snapshotRevision: '', snapshotText: '', vectorVersion: '',
  }, noScopeState, memoryFileStore({
    [`${owner}/.agent/pattern.json`]: '',
    [`${owner}/.agent/facts.json`]: JSON.stringify([{ id: 'legacy', text: '过期行为模式' }]),
    [`${owner}/.agent/facts.md`]: '- 更旧的行为模式',
  }))
  expect(result.documents).toEqual([])
})

it('scope owner 不匹配时拒绝读取；已 tombstone 的群 scope 不产生文档', async () => {
  await expect(prepareMemory({
    ownerId: owner,
    scopes: [{ type: 'group', id: 'g1', ownerId: '08a80873-5266-43b9-a27c-d288b602a9cb', platform: 'qq', botId: 'bot', groupId: 'g1' }],
    sourceFilter: 'all', snapshotRevision: '', snapshotText: '', vectorVersion: '',
  }, noScopeState, memoryFileStore({}))).rejects.toThrow(/owner scope/u)

  let requested = 0
  const scopeState: MemoryRagScopeStatePort = {
    async getMemoryScopeState() { requested += 1; return { revision: '4:deleted', tombstoned: true } },
  }
  const result = await prepareMemory({
    ownerId: owner, scopes: [{ type: 'group', id: 'group-7', ownerId: owner, platform: 'qq', botId: 'bot-1', groupId: 'group-7' }],
    sourceFilter: 'all', snapshotRevision: '', snapshotText: '', vectorVersion: '',
  }, scopeState, memoryFileStore({
    [`${owner}/.agent/im/qq/bot-1/groups/group-7/profile.json`]: JSON.stringify({ text: '群内项目' }),
  }))
  expect(requested).toBe(1)
  expect(result.documents).toEqual([])
  expect(result.indexSource).toBe('scope-tombstone')
})

it('群 scope 使用已授权 owner 下的资料文件投影，并按 snapshot 去重', async () => {
  const scope = { type: 'group' as const, id: 'group-7', ownerId: owner, platform: 'qq', botId: 'bot-1', groupId: 'group-7' }
  const files = memoryFileStore({
    [`${owner}/.agent/im/qq/bot-1/groups/group-7/profile.json`]: JSON.stringify({ text: '每周讨论项目进度' }),
    [`${owner}/.agent/im/qq/bot-1/groups/group-7/summary.json`]: JSON.stringify({ summary: '群摘要不属于可召回来源' }),
    [`${owner}/.agent/im/qq/bot-1/groups/group-7/daily.md`]: '## 2026-09-12\n- 讨论了发布计划\n',
    [`${owner}/.agent/im/qq/bot-1/groups/group-7/memory.md`]: '# 项目\n群内项目细节',
  })
  const result = await prepareMemory({
    ownerId: owner, scopes: [scope], sourceFilter: 'all', snapshotRevision: '', snapshotText: '', vectorVersion: '',
  }, noScopeState, files)
  expect(result.documents.map((document) => document.source_id)).toEqual(['profile', 'daily', 'memory'])
  for (const document of result.documents) {
    expect(document.scope_type).toBe('group')
    expect(document.scope_id).toBe('group-7')
    expect(document.group_id).toBe('group-7')
  }

  const duplicate = await prepareMemory({
    ownerId: owner, scopes: [scope], sourceFilter: 'profile', snapshotRevision: '',
    snapshotText: `之前的上下文：${result.documents[0]?.content}`, vectorVersion: '',
  }, noScopeState, files)
  expect(duplicate.documents).toEqual([])
})

it('scope 状态查询按 owner 和完整 scope key 读取 revision、映射成员类型并执行 tombstone 屏障', async () => {
  const native = new SQLite(':memory:')
  const db = new Kysely<Record<string, never>>({ dialect: new SqliteDialect({ database: native }) })
  try {
    await sql`CREATE TABLE memory_reflection_cursors (
      owner_user_id TEXT NOT NULL, platform TEXT NOT NULL, bot_id TEXT NOT NULL,
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, scope_version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`.execute(db)
    await sql`CREATE TABLE memory_scope_tombstones (
      owner_user_id TEXT NOT NULL, platform TEXT NOT NULL, bot_id TEXT NOT NULL,
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, status TEXT NOT NULL
    )`.execute(db)
    await sql`INSERT INTO memory_reflection_cursors
      VALUES (${owner}, 'qq', 'bot-a', 'group', 'group-a', 4, '2026-11-14T09:10:11.000Z')`.execute(db)
    await sql`INSERT INTO memory_reflection_cursors
      VALUES (${owner}, 'qq', 'bot-a', 'platform-user', 'group-a:user-a', 7, '2026-11-14T09:12:13.000Z')`.execute(db)
    await sql`INSERT INTO memory_scope_tombstones
      VALUES (${owner}, 'qq', 'bot-a', 'group', 'group-a', 'deleted')`.execute(db)

    const read = createSqlMemoryScopeStateReader(db)
    expect(await read({ ownerId: owner }, { type: 'group', id: 'group-a', platform: 'qq', botId: 'bot-a' }))
      .toEqual({ revision: '4:2026-11-14T09:10:11.000Z', tombstoned: true })
    expect(await read({ ownerId: owner }, { type: 'member', id: 'group-a:user-a', platform: 'qq', botId: 'bot-a' }))
      .toEqual({ revision: '7:2026-11-14T09:12:13.000Z', tombstoned: false })
    expect(await read({ ownerId: '08a80873-5266-43b9-a27c-d288b602a9cb' }, {
      type: 'group', id: 'group-a', platform: 'qq', botId: 'bot-a',
    })).toEqual({ revision: 'missing', tombstoned: false })
    expect(await read({ ownerId: owner }, { type: 'group', id: 'absent', platform: 'qq', botId: 'bot-a' }))
      .toEqual({ revision: 'missing', tombstoned: false })
    await expect(read({ ownerId: owner }, { type: 'group', id: '', platform: 'qq', botId: 'bot-a' }))
      .rejects.toMatchObject({ code: 'invalid_request', message: 'Memory scope 缺少必要字段' })
  } finally {
    await db.destroy()
  }
})
})
