import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { CoreError } from '../../../src/contracts/index.js'
import { utc as domainUtc } from '../../../src/shared/timestamps.js'
import { utc as codecUtc, databaseTime, projectRecord } from '../../../src/data/codec.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createKyselyProjectCreateRuntime } from '../../../src/projects/create-store.js'
import { createProjectCreator } from '../../../src/projects/project-create.js'
import type { ProjectCreatedEvent } from '../../../src/projects/project-create.js'
import { projectResponse } from '../../../src/projects/project-projection.js'

const cases = [
  { input: '2026-01-02T03:04:05Z', canonical: '2026-01-02 03:04:05+00:00', storage: '2026-01-02 03:04:05.000000', publicTime: '2026-01-02T03:04:05+00:00', day: '2026-01-02' },
  { input: '2026-01-02T03:04:05.123000Z', canonical: '2026-01-02 03:04:05.123000+00:00', storage: '2026-01-02 03:04:05.123000', publicTime: '2026-01-02T03:04:05.123000+00:00', day: '2026-01-02' },
  { input: '2026-01-02T03:04:05.123456Z', canonical: '2026-01-02 03:04:05.123456+00:00', storage: '2026-01-02 03:04:05.123456', publicTime: '2026-01-02T03:04:05.123456+00:00', day: '2026-01-02' },
  { input: '2026-01-02T01:04:05.123456+08:00', canonical: '2026-01-01 17:04:05.123456+00:00', storage: '2026-01-01 17:04:05.123456', publicTime: '2026-01-01T17:04:05.123456+00:00', day: '2026-01-01' },
  { input: '2026-01-02 23:04:05.123-04', canonical: '2026-01-03 03:04:05.123000+00:00', storage: '2026-01-03 03:04:05.123000', publicTime: '2026-01-03T03:04:05.123000+00:00', day: '2026-01-03' },
] as const
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

describe('时间公共化保持旧codec canonical及存储契约', () => {
  it.each(cases)('两入口保留精确微秒与偏移：$input', expected => {
    expect(codecUtc(expected.input)).toBe(expected.canonical)
    expect(domainUtc(expected.input)).toBe(expected.canonical)
    expect(databaseTime(expected.input, 'sqlite')).toBe(expected.storage)
    expect(databaseTime(expected.input, 'postgres')).toBe(expected.canonical)
  })
  it.each([
    null, 123, new Date('2026-01-01T00:00:00Z'), {}, '', '无效时间',
    '2026-02-30T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00.1234567Z',
    '2026-01-01T00:00:00+25:00', '0000-01-01T00:00:00Z',
    '0001-01-01T00:00:00+01:00', '9999-12-31T23:59:59-01:00',
  ])('非法时间/类型/UTC年越界仍为storage_error：%j', value => {
    for (const convert of [codecUtc, domainUtc]) {
      expect(() => convert(value)).toThrowError(CoreError)
      expect(() => convert(value)).toThrowError(expect.objectContaining({ code: 'storage_error' }))
    }
    for (const backend of ['sqlite', 'postgres'] as const)
      expect(() => databaseTime(value as string, backend)).toThrowError(expect.objectContaining({ code: 'storage_error' }))
  })
})

describe('项目真实SQLite记录的公开时间与事件投影', () => {
  it.each(cases)('DTO与创建事件使用T，内部记录/数据库/Undo原值不变：$input', async expected => {
    const folder = await mkdtemp(join(tmpdir(), 'gugu-project-time-'))
    cleanups.push(() => rm(folder, { recursive: true, force: true }))
    const filename = join(folder, 'core.db')
    await initializeSqlite(filename)
    const { runtime, ownerId } = await openSqliteRuntime(filename)
    cleanups.push(() => runtime.close())
    const publications: ProjectCreatedEvent[] = []
    const create = createProjectCreator(createKyselyProjectCreateRuntime({ db: runtime.db, backend: 'sqlite', clock: () => expected.input,
      async publishProjectCreated(event) { publications.push(event) },
    }))
    const created = await create(ownerId, { name: '时间项目', stages: [{ key: 's0', label: '设计', custom: '保留' }], current_stage: 's0' }, { undoContextId: 'tab' })
    const internalBefore = structuredClone(created.project)
    const rawBefore = await runtime.db.selectFrom('projects').selectAll().where('id', '=', created.project.id).executeTakeFirstOrThrow()
    const undoBefore = await runtime.db.selectFrom('undo_operations').selectAll().execute()
    expect(created.project.updated_at).toBe(expected.canonical)
    expect(rawBefore.updated_at).toBe(expected.storage)
    expect(rawBefore.created_at).toBe(expected.storage)
    const dto = projectResponse(created.project, 2)
    expect(dto).toMatchObject({ id: created.project.id, createdAt: expected.day, updatedAt: expected.publicTime, doneAt: null, deletedAt: null, fileCount: 2,
      stages: [{ key: 's0', label: '设计', custom: '保留' }] })
    expect(publications).toHaveLength(1)
    expect(publications[0]!.payload).toMatchObject({ createdAt: expected.day, updatedAt: expected.publicTime, doneAt: null, deletedAt: null, fileCount: 0 })
    expect(created.project).toEqual(internalBefore)
    expect(await runtime.db.selectFrom('projects').selectAll().where('id', '=', created.project.id).executeTakeFirstOrThrow()).toEqual(rawBefore)
    expect(await runtime.db.selectFrom('undo_operations').selectAll().execute()).toEqual(undoBefore)
    // 已完成/软删记录同样只在公开DTO改格式，原数据库与内部canonical保留空格及微秒。
    await sql`UPDATE projects SET done_at=${expected.storage},deleted_at=${expected.storage} WHERE id=${created.project.id}`.execute(runtime.db)
    const stored = await runtime.db.selectFrom('projects').selectAll().where('id', '=', created.project.id).executeTakeFirstOrThrow()
    const record = projectRecord(stored), snapshot = structuredClone(record)
    expect(projectResponse(record, 0)).toMatchObject({ updatedAt: expected.publicTime, doneAt: expected.publicTime, deletedAt: expected.publicTime })
    expect(record.done_at).toBe(expected.canonical)
    expect(record.deleted_at).toBe(expected.canonical)
    expect(record).toEqual(snapshot)
    expect(await runtime.db.selectFrom('projects').selectAll().where('id', '=', created.project.id).executeTakeFirstOrThrow()).toEqual(stored)
    expect(await runtime.db.selectFrom('undo_operations').selectAll().execute()).toEqual(undoBefore)
  })
})
