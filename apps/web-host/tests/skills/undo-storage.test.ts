import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillPackageDigest } from '@gugu/core/skills'
import { createLocalSkillUndoStorage } from '../../src/modules/skills/undo-storage.js'
import { createHostCoreUndoOperations } from '../../src/modules/undo/service.js'
import { initializeSqlite, openSqliteRuntime } from '@gugu/core/data'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import type { Pool } from 'pg'
import { createHash } from 'node:crypto'
import { createUserSkillBundle } from '@gugu/core/skills'
import { createWebFileSkillDeleter } from '../../src/modules/skills/file-delete.js'

test('技能安装撤销和重做保留完整包，后续修改会阻止撤销', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-undo-'))
  const owner = '00000000-0000-4000-8000-000000000001'
  const operationId = 'op-00000000000000000000000000000001'
  const target = join(root, owner, '.agent', 'skills', 'demo')
  try {
    await mkdir(join(target, 'references'), { recursive: true })
    await writeFile(join(target, 'SKILL.md'), '原始技能')
    await writeFile(join(target, 'references/a.md'), '资料')
    const digest = await skillPackageDigest(target)
    const storage = createLocalSkillUndoStorage(root)
    await writeFile(join(target, 'references/a.md'), '后续修改')
    await assert.rejects(storage.move({ ownerId: owner, slug: 'demo', operationId, digest, mode: 'undo' }), { code: 'conflict' })
    assert.equal(await readFile(join(target, 'references/a.md'), 'utf8'), '后续修改')
    await writeFile(join(target, 'references/a.md'), '资料')
    const rollback = await storage.move({ ownerId: owner, slug: 'demo', operationId, digest, mode: 'undo' })
    await assert.rejects(readFile(join(target, 'SKILL.md')), { code: 'ENOENT' })
    await rollback()
    assert.equal(await readFile(join(target, 'references/a.md'), 'utf8'), '资料')
    await storage.move({ ownerId: owner, slug: 'demo', operationId, digest, mode: 'undo' })
    await storage.move({ ownerId: owner, slug: 'demo', operationId, digest, mode: 'redo' })
    assert.equal(await readFile(join(target, 'references/a.md'), 'utf8'), '资料')
    await symlink('/synthetic', join(target, 'linked'))
    await assert.rejects(storage.move({ ownerId: owner, slug: 'demo', operationId, digest, mode: 'undo' }), { code: 'conflict' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('统一撤销状态机提交技能安装的撤销重做，事务失败时补偿文件移动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-undo-engine-'))
  const database = join(root, 'test.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  const storageRoot = join(root, 'storage')
  const target = join(storageRoot, ownerId, '.agent', 'skills', 'demo')
  const id = 'op-00000000000000000000000000000002'
  const db = runtime.db as any
  const raw = (statement: string) => db.executeQuery({ sql: statement, parameters: [], query: { kind: 'RawNode', sqlFragments: [statement], parameters: [] } })
  try {
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), '技能正文')
    const digest = await skillPackageDigest(target)
    await db.insertInto('undo_operations').values({ id, user_id: ownerId.replaceAll('-', ''), undo_context_id: 'editor',
      group_id: 'group', resource: 'skills', action: 'install', target_refs: '[]', before_state: '{}',
      after_state: JSON.stringify({ slug: 'demo', digest }), base_versions: '{}', artifact_refs: '{}', actor_type: 'web',
      status: 'active', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      undone_at: null, failure_code: null }).execute()
    const events: Record<string, unknown>[] = []
    const service = createHostCoreUndoOperations({} as Pool, createRuntimeUndoTransactionPort(runtime),
      async (_owner, event) => { events.push(event) }, undefined, undefined, createLocalSkillUndoStorage(storageRoot))
    await raw("CREATE TRIGGER fail_skill_undo BEFORE UPDATE ON undo_operations BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    await assert.rejects(service.apply(ownerId, 'editor', id, 'undo'))
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), '技能正文')
    await raw('DROP TRIGGER fail_skill_undo')
    await service.apply(ownerId, 'editor', id, 'undo')
    await assert.rejects(readFile(join(target, 'SKILL.md')), { code: 'ENOENT' })
    await service.apply(ownerId, 'editor', id, 'redo')
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), '技能正文')
    assert.deepEqual(events.map(event => event.resource), ['skills', 'skills'])
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})

test('统一撤销状态机恢复技能正文并拒绝覆盖外部修改', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-edit-undo-'))
  const database = join(root, 'test.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  const storageRoot = join(root, 'storage')
  const target = join(storageRoot, ownerId, '.agent', 'skills', 'demo')
  const id = 'op-00000000000000000000000000000003'
  const before = '---\nname: 示例\ndescription: 描述\n---\n原文'
  const after = '---\nname: 示例\ndescription: 描述\n---\n新文'
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const db = runtime.db as any
  try {
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), after)
    await db.insertInto('undo_operations').values({ id, user_id: ownerId.replaceAll('-', ''), undo_context_id: 'editor',
      group_id: 'group', resource: 'skills', action: 'update', target_refs: '[]',
      before_state: JSON.stringify({ source: before, digest: digest(before) }),
      after_state: JSON.stringify({ slug: 'demo', source: after, digest: digest(after) }),
      base_versions: '{}', artifact_refs: '{}', actor_type: 'web', status: 'active',
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString(), undone_at: null, failure_code: null }).execute()
    const service = createHostCoreUndoOperations({} as Pool, createRuntimeUndoTransactionPort(runtime),
      async () => {}, undefined, undefined, createLocalSkillUndoStorage(storageRoot))
    await service.apply(ownerId, 'editor', id, 'undo')
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), before)
    await service.apply(ownerId, 'editor', id, 'redo')
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), after)
    await writeFile(join(target, 'SKILL.md'), `${after}\n外部更新`)
    await assert.rejects(service.apply(ownerId, 'editor', id, 'undo'), { code: 'undo.conflict' })
    assert.equal(await readFile(join(target, 'SKILL.md'), 'utf8'), `${after}\n外部更新`)
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})

test('Web 删除技能登记撤销，统一状态机恢复及重做整个目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-skill-delete-undo-'))
  const database = join(root, 'test.db')
  await initializeSqlite(database)
  const { runtime, ownerId } = await openSqliteRuntime(database)
  const storageRoot = join(root, 'storage')
  const records: unknown[][] = []
  const client = { async query(statement: string, values?: unknown[]) {
    if (statement.includes('INSERT INTO undo_operations')) records.push(values!)
    return { rows: [], rowCount: 1 }
  }, release() {} }
  try {
    await mkdir(storageRoot)
    const skill = await createUserSkillBundle(storageRoot, ownerId, 'demo', '---\nname: 示例\ndescription: 描述\n---\n正文')
    await mkdir(join(skill.path, 'assets'))
    await writeFile(join(skill.path, 'assets/a.txt'), '配套资料')
    const remove = createWebFileSkillDeleter({ pool: { connect: async () => client } as unknown as Pool,
      dataRoot: storageRoot, async publish() {} })
    await assert.rejects(remove(ownerId, 'demo', 'f'.repeat(64), 'editor'), { code: 'conflict' })
    await remove(ownerId, 'demo', skill.contentDigest, 'editor')
    await assert.rejects(readFile(join(skill.path, 'SKILL.md')), { code: 'ENOENT' })
    const values = records[0]!
    const db = runtime.db as any
    await db.insertInto('undo_operations').values({ id: values[0], user_id: ownerId.replaceAll('-', ''), undo_context_id: 'editor',
      group_id: values[3], resource: 'skills', action: 'remove', target_refs: values[6], before_state: values[7], after_state: values[8],
      base_versions: '{}', artifact_refs: '{}', actor_type: 'web', status: 'active', created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), undone_at: null, failure_code: null }).execute()
    const service = createHostCoreUndoOperations({} as Pool, createRuntimeUndoTransactionPort(runtime),
      async () => {}, undefined, undefined, createLocalSkillUndoStorage(storageRoot))
    await service.apply(ownerId, 'editor', String(values[0]), 'undo')
    assert.equal(await readFile(join(skill.path, 'assets/a.txt'), 'utf8'), '配套资料')
    await service.apply(ownerId, 'editor', String(values[0]), 'redo')
    await assert.rejects(readFile(join(skill.path, 'SKILL.md')), { code: 'ENOENT' })
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
})
