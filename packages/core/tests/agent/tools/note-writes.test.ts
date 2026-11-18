import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { dataContext } from '../../../src/contracts/index.js'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createNoteWritePort, createNoteWriteTools } from '../../../src/agent/tools/note.js'
import { createToolRegistry } from '../../../src/agent/tools/registry.js'

it('笔记结构化引用必须归属当前 owner，创建和行编辑一次提交并按调用收据重放', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'gugu-note-writes-'))
  try {
    const path = join(folder, 'core.db')
    await initializeSqlite(path)
    const { runtime: core, ownerId } = await openSqliteRuntime(path)
    try {
      const identity = { ownerId, sessionId: '21', runId: 'synthetic-note-run' }
      const outsider = randomUUID()
      const project = await core.transaction(dataContext(ownerId), db => db.projects.create({ name: '合成项目' }))
      const foreign = await core.transaction(dataContext(outsider), db => db.projects.create({ name: '他人项目' }))
      let published = 0
      let allowed = true
      const port = createNoteWritePort(core, {
        now: () => new Date('2026-11-18T15:00:00Z'), timezone: 'Asia/Shanghai',
        async publish() { published++ },
      })
      const registry = createToolRegistry({
        authorize: async candidate => allowed && candidate.ownerId === ownerId,
        groups: [{ id: 'mind', name: '笔记', tools: createNoteWriteTools(port) }],
      })
      const dispatch = (id: string, name: string, input: unknown, owner = ownerId) => registry.tools.dispatch({ id, name, input }, {
        identity: { ...identity, ownerId: owner }, roundId: '1', signal: new AbortController().signal,
        resolution: null, async execute() { throw new Error('笔记工具不调用执行器') },
      })

      const block = (id: number) => ({
        type: 'paragraph',
        content: [{ type: 'reference', ref_type: 'project', ref_id: id, label: '引用项目' }],
      })
      expect(await dispatch('foreign', 'note_create', { blocks: [block(foreign.id)] }))
        .toMatchObject({ successful: false, mutated: false, value: { error: '引用对象不存在' } })
      const input = { content: JSON.stringify([{ type: 'heading', content: [{ text: '标题' }] }, block(project.id)]), captured_at: '11月17日' }
      const created = await dispatch('create', 'note_create', input)
      expect(created).toMatchObject({ successful: true, mutated: true, value: {
        note: { origin: 'gugu', kind: 'note', content_md: `# 标题\n\n[[project:${project.id}|引用项目]]` },
      } })
      if (created.kind !== 'completed') throw new Error('创建结果无效')
      const id = (created.value as { note: { node_id: number; captured_at: string } }).note.node_id
      expect(new Date((created.value as { note: { captured_at: string } }).note.captured_at).toISOString()).toBe('2026-11-17T04:00:00.000Z')
      expect(await dispatch('create', 'note_create', input)).toMatchObject({ successful: true, mutated: false, value: created.value })
      const edit = (expected: string) => ({ node_id: id, captured_at: '2026-11-17T04:00:00.123456Z', line_edits: [{ target_lines: '1', content: '# 新标题', expected }] })
      expect(await dispatch('stale', 'note_update', edit('过时'))).toMatchObject({ successful: false, mutated: false })
      expect(await dispatch('foreign-update', 'note_update', edit('# 标题'), outsider)).toMatchObject({ successful: false })
      expect(await dispatch('update', 'note_update', edit('# 标题'))).toMatchObject({
        successful: true, mutated: true, value: { note: { captured_at: '2026-11-17T04:00:00.123456+00:00', content_md: `# 新标题\n\n[[project:${project.id}|引用项目]]` } },
      })
      expect(await dispatch('update', 'note_update', edit('# 标题'))).toMatchObject({ successful: true, mutated: false })
      expect(await core.db.selectFrom('mind_nodes').select(['id', 'version', 'origin']).execute()).toEqual([{ id, version: 2, origin: 'gugu' }])
      expect(await core.db.selectFrom('undo_operations').select('action').orderBy('action').execute()).toEqual([{ action: 'create' }, { action: 'update' }])
      expect(published).toBe(2)
      allowed = false
      expect(await dispatch('revoked', 'note_update', { node_id: id, append_markdown: '无权写入' })).toMatchObject({ successful: false })
    } finally { await core.close() }
  } finally { await rm(folder, { recursive: true, force: true }) }
})
