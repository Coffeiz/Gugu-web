import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createSaveAttachmentTool } from '@gugu/core/tools'
import { createWebAgentSaveAttachmentPort } from '../../../src/modules/agent/tools/files/save.js'
import { createAgentToolRegistry } from '../../../src/modules/agent/tools/registry.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('附件保存走物理路径，恢复收据不重复写入，精确 ID 可跨会话，拒绝其他 owner 和失效授权', {
  skip: !url || process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-attachment-path-'))
  const schema = 'gugu_save_path_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: url })
  await admin.query('CREATE SCHEMA "' + schema + '"')
  const pool = new Pool({ connectionString: url, options: '-c search_path=' + schema })
  const core = await createPostgresRuntime({ url: url!, schema })
  const ownerId = randomUUID(), identity = { ownerId, sessionId: '18', runId: 'save-path-run' }
  const path = join(root, ownerId, '个人文件', '资料')
  const source = join(root, 'incoming.txt')
  try {
    await pool.query(tablesSql('postgres').receipts)
    const otherOwner = randomUUID()
    await pool.query(`CREATE TABLE conversation_sessions (id integer PRIMARY KEY, user_id uuid);
      CREATE TABLE conversation_messages (id integer PRIMARY KEY, session_id integer);
      CREATE TABLE chat_attachments (id integer PRIMARY KEY, user_id uuid, message_id integer, attach_id text,
        kind text, size bigint, state text, created_at timestamptz)`)
    await pool.query('INSERT INTO conversation_sessions VALUES (18,$1),(19,$1),(20,$2)', [ownerId, otherOwner])
    await pool.query('INSERT INTO conversation_messages VALUES (1,18),(2,19),(3,20)')
    await pool.query(`INSERT INTO chat_attachments VALUES
      (1,$1,1,'attachment-1','text',12,'attached','2026-01-01'),
      (2,$1,2,'history','text',12,'attached','2026-01-02'),
      (3,$2,3,'foreign','text',12,'attached','2026-01-03')`, [ownerId, otherOwner])
    await mkdir(path, { recursive: true })
    await writeFile(source, '附件正文')
    let active = true
    const downloads: string[] = []
    const reads = { async query(sql: string, args: unknown[]) {
      if (sql.includes('FROM chat_attachments')) return pool.query(sql, args)
      assert.match(sql, /agent_run_dispatch/)
      return { rowCount: active ? 1 : 0, rows: active ? [{}] : [] }
    } } as never
    const port = createWebAgentSaveAttachmentPort({ pool: reads, core, storageRoot: root,
      lease: { identity, token: 'lease-token', fence: 5, input: { v: 2, source: 'web' } } as never,
      async downloadAttachment(owner, id) {
        assert.equal(owner, ownerId)
        assert.ok(id === 'attachment-1' || id === 'history')
        downloads.push(id)
        return { fileName: '标题.txt', ext: 'txt', mimeType: 'text/plain', handle: await open(source, 'r') }
      },
    })
    const registry = createAgentToolRegistry({ core, saveAttachment: createSaveAttachmentTool(port), authorize: async () => true })
    const scope = { identity, roundId: 'round', signal: new AbortController().signal, resolution: null,
      execute: async () => { throw new Error('附件保存不得执行宿主 Shell') } }
    const dispatch = (id: string, input: Record<string, unknown>) =>
      registry.tools.dispatch({ id, name: 'save_attachment', input }, scope)
    const target = { source: 'latest', folder_path: '资料' }
    const first = await dispatch('save', target)
    assert.equal(first.kind, 'completed')
    if (first.kind !== 'completed') throw new Error('保存未完成')
    assert.equal(first.successful, true, JSON.stringify(first))
    const value = first.value as { name: string; path: string; link: string }
    assert.match(value.path, /^\/personal\/资料\//u)
    assert.match(value.link, /^gugu:\/\/open-object\/file\/path-/u)
    assert.equal(await readFile(join(path, value.name), 'utf8'), '附件正文')
    const replay = await dispatch('save', target)
    assert.deepEqual(replay, { ...first, mutated: false })
    assert.deepEqual(await readdir(path), [value.name])
    assert.deepEqual(downloads, ['attachment-1'])
    const historical = await dispatch('history', { attach_id: 'history', folder_path: '资料' })
    assert.equal(historical.kind === 'completed' && historical.successful, true)
    for (const [id, input] of [
      ['other-owner', { attach_id: 'foreign' }],
      ['missing', { ...target, folder_path: '不存在' }], ['traversal', { ...target, folder_path: '../资料' }],
    ] as const) {
      const failed = await dispatch(id, input)
      assert.equal(failed.kind === 'completed' && failed.successful, false)
    }
    const defaultSave = await dispatch('default-download', { attach_id: 'history' })
    assert.equal(defaultSave.kind === 'completed' && defaultSave.successful, true)
    if (defaultSave.kind !== 'completed') throw new Error('保存未完成')
    assert.match((defaultSave.value as { path: string }).path, /^\/personal\/download\//u)
    active = false
    const denied = await dispatch('denied', target)
    assert.equal(denied.kind === 'completed' && denied.successful, false)
    assert.deepEqual(downloads, ['attachment-1', 'history', 'history'])
  } finally {
    await core.close()
    await pool.end()
    await admin.query('DROP SCHEMA "' + schema + '" CASCADE')
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
