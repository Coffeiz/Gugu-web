import { resolveDesktopChatReferences } from '../../../src/agent/sessions/desktop-references.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { sql } from 'kysely'
import { initializeSqlite, openSqliteRuntime } from '../../../src/data/sqlite.js'
import { createAgentSessionApplication } from '../../../src/agent/sessions/application.js'
import { createSqlAgentSessionRepository } from '../../../src/agent/sessions/data.js'

test('正式 SQLite 会话改名、消息定位和 owner 隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-agent-session-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path); const { runtime, ownerId } = await openSqliteRuntime(path)
    try {
      const owner = ownerId.replaceAll('-', '')
      await sql`INSERT INTO conversation_sessions(id,user_id,title,title_locked,summary,source,context_epoch,created_at,updated_at) VALUES (1,${owner},'旧',0,'','web',1,'2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000')`.execute(runtime.db)
      await sql`INSERT INTO conversation_messages(id,session_id,conversation_seq,role,content,content_json,created_at) VALUES (1,1,1,'user','',NULL,'2026-01-01 00:00:00.000000'),(2,1,2,'assistant','合成隐藏模型消息','[]','2026-01-01 00:00:00.000000'),(3,1,3,'summary','合成内部摘要',NULL,'2026-01-01 00:00:00.000000'),(5,1,5,'assistant','','null','2026-01-01 00:00:00.000000'),(6,1,6,'user','合成引用','[]','2026-01-01 00:00:00.000000')`.execute(runtime.db)
      const app = createAgentSessionApplication(createSqlAgentSessionRepository(runtime.db, 'sqlite'))
      assert.deepEqual(await app.rename(ownerId, 1, `  ${'😀'.repeat(300)}  `), { id: 1, title: '😀'.repeat(300), title_locked: true })
      await assert.rejects(app.rename(ownerId, 1, '😀'.repeat(301)), /标题过长/)
      await assert.rejects(app.rename(ownerId, 1, '  '), /标题不能为空/)
      assert.equal(await app.rename(randomUUID(), 1, '越权'), null)
      assert.deepEqual(await app.locate(ownerId, 1), { id: 1, sessionId: 1 })
      assert.deepEqual(await app.locate(ownerId, 6), { id: 6, sessionId: 1 })
      assert.equal(await app.locate(randomUUID(), 1), null)
      for (const id of [2, 3, 4, 5]) assert.equal(await app.locate(ownerId, id), null)
      const references = [2, 3, 6].map(id => ({ type: 'conversation', id, label: '合成引用' }))
      const context = await resolveDesktopChatReferences(runtime.db, ownerId, references, '合成请求')
      assert.match(context, /【消息内容】"合成引用"/u)
      assert.doesNotMatch(context, /合成隐藏模型消息|合成内部摘要/u)
      assert.equal(await resolveDesktopChatReferences(runtime.db, randomUUID(), references, '合成请求'), '合成请求')
      await sql`INSERT INTO mind_nodes(id,user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at)
        VALUES (9,${owner},'note','合成普通笔记','正文选区','正文选区','user',3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`.execute(runtime.db)
      const noteRef = { type: 'canvas_note', id: 9, label: '合成普通笔记' }
      const selected = { ...noteRef, selection: { location: '合成段落', content: '正文选区', version: 3 } }
      const noteContext = await resolveDesktopChatReferences(runtime.db, ownerId, [selected], '修改一下')
      assert.match(noteContext, /【引用对象】[\s\S]*【ID】9[\s\S]*【选区原文】"正文选区"[\s\S]*【\/引用对象】/u)
      assert.match(await resolveDesktopChatReferences(runtime.db, ownerId, [noteRef], '修改一下'), /【正文】"正文选区"/u)
      assert.equal(await resolveDesktopChatReferences(runtime.db, randomUUID(), [selected], '修改一下'), '修改一下')
    } finally { await runtime.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('隔离缺表库明确要求升级', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-agent-session-missing-')), path = join(dir, 'core.db')
  try {
    await initializeSqlite(path); const { runtime } = await openSqliteRuntime(path)
    try {
      await sql`DROP TABLE conversation_messages`.execute(runtime.db)
      const app = createAgentSessionApplication(createSqlAgentSessionRepository(runtime.db, 'sqlite'))
      await assert.rejects(app.locate(randomUUID(), 1), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'schema_upgrade_required')
    } finally { await runtime.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('桌面技能引用解析当前用户文件，不暴露其他用户内容', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gugu-skill-reference-'))
  const owner = randomUUID(), other = randomUUID()
  try {
    const { createUserSkillBundle } = await import('../../../src/agent/skills/bundle-store.js')
    await createUserSkillBundle(root, owner, 'demo', '---\nname: 技能名称\ndescription: 技能简介\nmetadata:\n  gugu:\n    enabled: false\n---\n不应注入的正文')
    const references = [{ type: 'skill', id: 'demo', label: '伪造名称' }]
    const render = (id: string) => resolveDesktopChatReferences({} as never, id, references, '问题', undefined, false, undefined, root)
    const output = await render(owner)
    assert.match(output, /技能名称/u)
    assert.match(output, /已停用/u)
    assert.ok(output.includes(join(root, owner, '.agent', 'skills', 'demo')))
    assert.doesNotMatch(output, /不应注入的正文|伪造名称/u)
    assert.equal(await render(other), '问题')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
