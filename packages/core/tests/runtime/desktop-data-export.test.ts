import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { importDesktopBusinessArchive } from '../../src/data-portability/desktop-import.js'
import { readDesktopDataInventory } from '../../src/data-portability/desktop-inventory.js'
import { DEFAULT_PROJECT_COLOR, PROJECT_COLOR_PRESETS } from '../../src/projects/colors.js'
import { exportDesktopBusinessArchive } from '../../src/data-portability/desktop-export.js'
import { createDesktopMemoryFiles } from '../../src/agent/memory/desktop-files.js'
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

it('旧版归档按可移植 ID 恢复项目、日历与画布关系，并支持重复导入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-related-import-test-'))
  try {
    const database = join(directory, 'local.db')
    await initializeSqlite(database)
    const { runtime, ownerId } = await openSqliteRuntime(database)
    try {
      const relation = (relation_type: string, target_type: string, target_portable_id: string) =>
        ({ relation_type, target_type, target_portable_id })
      const record = (type: string, portable_id: string, fields: object, relations: object[] = []) =>
        ({ record_schema: 'gugu.' + type + '.v1', source_type: type, portable_id, fields, relations })
      const archive: Record<string, Uint8Array> = {}
      const categories: Record<string, { included: boolean; bytes: number; records: number }> = {}
      const entries: Array<{ path: string; category: string; size: number; sha256: string; records: number }> = []
      function add(path: string, category: string, data?: object | string, count = Number(typeof data === 'object')) {
        const bytes = strToU8(typeof data === 'string' ? data : data ? JSON.stringify(data) + '\n' : '合成归档')
        archive[path] = bytes
        const records = count
        entries.push({ path, category, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), records })
        const total = categories[category] ??= { included: true, bytes: 0, records: 0 }
        total.bytes += bytes.length
        total.records += records
      }
      // 故意把依赖对象放在使用方之后，保护旧版 manifest 的无序导入。
      add('records/mind/canvas_items.jsonl', 'mind', record('mind_canvas_item', 'item',
        { x: 10, y: 20, w: null, h: null, z: 0, collapsed: false, data: {} },
        [relation('node', 'mind_node', 'note'), relation('canvas', 'mind_map', 'canvas')]))
      add('records/mind/nodes.jsonl', 'mind', record('mind_node', 'note',
        { kind: 'note', title: '合成笔记', content_md: '正文', content_plain: '正文', origin: 'user' }))
      add('records/mind/canvases.jsonl', 'mind', record('mind_map', 'canvas',
        { title: '合成画布', data: {} }, [relation('project', 'project', 'project')]))
      add('records/calendar/events.jsonl', 'calendar', record('calendar_event', 'event',
        { title: '合成日程', date: '2026-01-01', time: '08:00', type: 'event' }, [relation('project', 'project', 'project')]))
      add('records/projects.jsonl', 'projects', record('project', 'project', {
        name: '合成/项目', color: 'linear-gradient(135deg, #123456, #654321)',
      }))
      add('records/conversations/sessions.jsonl', 'conversations', record('conversation', 'chat', { title: '合成对话' }))
      add('records/conversations/batches.jsonl', 'conversations', record('conversation_batch', 'batch',
        { version: 1 }, [relation('session', 'conversation', 'chat')]))
      add('records/conversations/messages.jsonl', 'conversations', record('message', 'message',
        { role: 'assistant', content: '合成答复' }, [relation('session', 'conversation', 'chat'), relation('batch', 'conversation_batch', 'batch')]))
      add('records/conversations/drafts.jsonl', 'drafts', record('pending_queue', 'draft',
        { items: [{ key: 1, text: '合成草稿' }] }, [relation('session', 'conversation', 'chat')]))
      add('records/scheduled_tasks.jsonl', 'scheduled_tasks', record('scheduled_task', 'task',
        { name: '合成提醒', payload: '提醒', cron: '0 8 * * *' }, [relation('event', 'calendar_event', 'event')]))
      add('records/feedback.jsonl', 'feedback', record('feedback', 'feedback', { category: 'other', content: '合成反馈' }))
      add('records/preferences.json', 'preferences', JSON.stringify(record('preferences', 'preferences', { data: { locale: 'zh-CN' } })), 1)
      add('memory/owner/memory.md', 'owner_memory', '合成个人记忆')
      add('memory/owner/profile.json', 'owner_memory', JSON.stringify([{ text: '合成本地资料' }, { text: '合成归档资料' }]))
      add('memory/owner/pattern.json', 'owner_memory', JSON.stringify([{ text: '合成归档偏好' }]))
      const scope = { platform: 'qq', bot_id: 'sample-bot', scope_type: 'group', scope_id: 'sample-group' } as const
      const hash = createHash('sha256').update(Object.values(scope).join('\0')).digest('hex').slice(0, 32)
      add('memory/im/scopes.jsonl', 'im_memory', JSON.stringify({ ...scope, deleted: false }) + '\n', 1)
      add('memory/im/scopes/' + hash + '/memory.md', 'im_memory', '合成群记忆')
      add('records/files/files.jsonl', 'files', '{}\n', 1)
      add('README.txt', 'archive_docs')
      archive['manifest.json'] = strToU8(JSON.stringify({
        format_version: '1.0', origin_id: randomUUID(), export_id: randomUUID(),
        created_at: '2026-01-01T00:00:00Z', complete: false, categories, entries,
      }))
      archive['checksums.sha256'] = strToU8(entries.map(entry => entry.sha256 + '  ' + entry.path).join('\n') + '\n')
      const file = join(directory, 'archive.zip')
      await writeFile(file, zipSync(archive))
      const memory = createDesktopMemoryFiles(runtime.db, directory, ownerId)
      await memory.initialize()
      await writeFile(join(directory, '.agent/memories/profile.json'), JSON.stringify([{ text: '合成本地资料', weight: 1 }]))
      await writeFile(join(directory, '.agent/memories/pattern.json'), JSON.stringify([{ text: '合成本地偏好' }]))
      const plan = await importDesktopBusinessArchive(runtime.db, ownerId, file, undefined, undefined, memory)
      // 归档导入不再把旧 Skill 记录写入 SQL；用户技能统一由文件包管理。
      expect(plan).toMatchObject({ added: 16, skipped: 1 })
      expect(await runtime.db.selectFrom('mind_maps').select('id').execute()).toEqual([])
      expect(JSON.parse((await memory.readTarget('profile'))!)).toEqual([{ text: '合成本地资料', weight: 1 }])
      expect(await importDesktopBusinessArchive(runtime.db, ownerId, file, plan.digest, undefined, memory)).toMatchObject({ added: 16, skipped: 1 })
      await memory.flush()
      await memory.flushImportedIm()
      const message = (await sql<{ content: string; conversation_seq: number }>`SELECT content,conversation_seq FROM conversation_messages`.execute(runtime.db)).rows[0]
      expect(message).toEqual({ content: '合成答复', conversation_seq: 1 })
      expect((await sql`SELECT enabled FROM scheduled_tasks`.execute(runtime.db)).rows).toEqual([{ enabled: 0 }])
      expect((await sql`SELECT skill_id,enabled FROM user_skills`.execute(runtime.db)).rows).toEqual([])
      expect(await memory.readTarget('memory')).toBe('合成个人记忆')
      expect(JSON.parse((await memory.readTarget('profile'))!)).toEqual([{ text: '合成本地资料', weight: 1 }, { text: '合成归档资料' }])
      expect(JSON.parse((await memory.readTarget('pattern'))!)).toEqual([{ text: '合成本地偏好' }, { text: '合成归档偏好' }])
      expect(await readDesktopDataInventory(runtime.db, ownerId, memory)).toMatchObject({
        desktop_sessions: 1, desktop_batches: 1, desktop_messages: 1, owner_memory: 3,
      })
      expect(await memory.readImScope({ ...scope, owner_user_id: ownerId }, 'memory.md')).toBe('合成群记忆')
      const project = await runtime.db.selectFrom('projects').select(['id', 'name', 'color']).executeTakeFirstOrThrow()
      expect(project).toMatchObject({ name: '合成_项目', color: DEFAULT_PROJECT_COLOR })
      const canvas = await runtime.db.selectFrom('mind_maps').select(['id', 'project_id']).executeTakeFirstOrThrow()
      const event = await runtime.db.selectFrom('calendar_events').select('project_id').executeTakeFirstOrThrow()
      const node = await runtime.db.selectFrom('mind_nodes').select('id').executeTakeFirstOrThrow()
      expect(event.project_id).toBe(project.id)
      expect(canvas.project_id).toBe(project.id)
      expect(await runtime.db.selectFrom('mind_canvas_items').select(['canvas_id', 'node_id']).executeTakeFirstOrThrow())
        .toEqual({ canvas_id: canvas.id, node_id: node.id })
      expect(await importDesktopBusinessArchive(runtime.db, ownerId, file, plan.digest, undefined, memory)).toMatchObject({ added: 0, skipped: 17 })
    } finally {
      await runtime.db.destroy()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
