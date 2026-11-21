import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { importDesktopBusinessArchive } from '../../src/data-portability/desktop-import.js'
import { PROJECT_COLOR_PRESETS } from '../../src/projects/colors.js'
import { exportDesktopBusinessArchive } from '../../src/data-portability/desktop-export.js'
import { initializeSqlite, openSqliteRuntime } from '../../src/data/sqlite.js'

it('超过 2 MiB 的项目与联系人归档可往返，校验失败回滚且重复导入去重', async () => {
  const notes = '合成资料'.repeat(280_000)
  const directory = await mkdtemp(join(tmpdir(), 'gugu-export-test-'))
  try {
    const database = join(directory, 'local.db')
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    try {
      const owner = ownerId.replaceAll('-', '')
      await sql`INSERT INTO clients(user_id,name,notes,created_at) VALUES
        (${owner},'小北',${notes},'2026-01-01 00:00:00'), (${randomUUID().replaceAll('-', '')},'其他联系人','','2026-01-01 00:00:00')`.execute(runtime.db)
      await sql`INSERT INTO projects(user_id,name,contact_name,status,color,progress,stages_json,version,archived,created_at,updated_at)
        VALUES (${owner},'测试项目','小北','pending',${PROJECT_COLOR_PRESETS[0]},0,'[]',1,0,'2026-01-01 00:00:00','2026-01-01 00:00:00')`.execute(runtime.db)
      const path = join(directory, 'portable.zip')
      const secondPath = join(directory, 'second.zip')
      await exportDesktopBusinessArchive(runtime.db, ownerId, path)
      await exportDesktopBusinessArchive(runtime.db, ownerId, secondPath)
      const first = await readFile(path)
      expect(first.byteLength).toBeGreaterThan(2 * 1024 * 1024)
      const zip = unzipSync(first)
      const again = unzipSync(await readFile(secondPath))
      const manifest = JSON.parse(strFromU8(zip['manifest.json']!))
      expect(manifest).toMatchObject({ format_version: '1.0', complete: false, categories: {
        projects: { included: true, records: 1 }, clients: { included: true, records: 1 },
      } })
      expect(manifest.origin_id).not.toBe(ownerId)
      expect(JSON.parse(strFromU8(again['manifest.json']!)).origin_id).toBe(manifest.origin_id)
      for (const path of ['records/projects.jsonl', 'records/clients.jsonl']) {
        expect(again[path]).toEqual(zip[path])
        const digest = createHash('sha256').update(zip[path]!).digest('hex')
        expect(strFromU8(zip['checksums.sha256']!)).toContain(`${digest}  ${path}\n`)
      }
      expect(JSON.parse(strFromU8(zip['records/projects.jsonl']!)).fields).toMatchObject({ name: '测试项目', client: '小北', stages: [] })
      expect(JSON.parse(strFromU8(zip['records/clients.jsonl']!)).fields.name).toBe('小北')
      const target = randomUUID()
      const targetDbOwner = target.replaceAll('-', '')
      const invalid = join(directory, 'invalid.zip')
      await writeFile(invalid, zipSync({ ...zip, 'records/unknown.jsonl': strToU8('{}\n') }, { level: 0 }))
      await expect(importDesktopBusinessArchive(runtime.db, target, invalid)).rejects.toThrow('归档损坏')
      const invalidDoc = zip['README.txt']!.slice()
      invalidDoc[0] = (invalidDoc[0] ?? 0) ^ 1
      const corrupted = zipSync({ ...zip, 'README.txt': invalidDoc }, { level: 0 })
      await writeFile(invalid, corrupted)
      await expect(importDesktopBusinessArchive(runtime.db, target, invalid, createHash('sha256').update(corrupted).digest('hex')))
        .rejects.toThrow('归档损坏')
      const plan = await importDesktopBusinessArchive(runtime.db, target, path)
      expect(plan).toMatchObject({ added: 2, skipped: 0 })
      const targetProjects = () => runtime.db.selectFrom('projects').select(['name', 'contact_name'])
        .where('user_id', '=', targetDbOwner).execute()
      expect(await targetProjects()).toEqual([])
      await writeFile(path, zipSync(again, { level: 0 }))
      await expect(importDesktopBusinessArchive(runtime.db, target, path, plan.digest)).rejects.toMatchObject({ code: 'conflict' })
      expect(await targetProjects()).toEqual([])
      const next = await importDesktopBusinessArchive(runtime.db, target, path)
      expect(await importDesktopBusinessArchive(runtime.db, target, path, next.digest)).toMatchObject({ added: 2, skipped: 0 })
      expect(await targetProjects()).toEqual([{ name: '测试项目', contact_name: '小北' }])
      expect(await runtime.db.selectFrom('clients').select(['name', 'notes']).where('user_id', '=', targetDbOwner).execute())
        .toEqual([{ name: '小北', notes }])
      await writeFile(path, first)
      const repeated = await importDesktopBusinessArchive(runtime.db, target, path)
      expect(await importDesktopBusinessArchive(runtime.db, target, path, repeated.digest)).toMatchObject({ added: 0, skipped: 2 })
    } finally {
      await runtime.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
