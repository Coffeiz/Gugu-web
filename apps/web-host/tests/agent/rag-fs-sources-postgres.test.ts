import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime } from '@gugu/core/data'
import { dataContext } from '@gugu/core/contracts'
import { createNoteWritePort } from '@gugu/core/tools'
import { createSqlRagPersistentIndexReader } from '../../../../packages/core/src/agent/rag/persistent-index.js'
import { enqueueAgentRagRebuild } from '../../../../packages/core/src/agent/rag/rebuild-worker.js'
import { createAgentRagRebuildWorker } from '../../src/domains/agent-sessions/rag-rebuild.js'
import { createAuthorizedWebAgentProductionRagRunPorts } from '../../src/domains/agent-sessions/tools/agent-rag-production-ports.js'
import { createLocalAgentKnowledgeReadStore } from '../../src/domains/agent-sessions/tools/agent-rag-knowledge-store.js'
import { applyAgentBaseMigration } from '../../src/migrations/agent-base-migrate.js'
import { applyAgentRunMigration } from '../../src/migrations/agent-run-migrate.js'
import { applyWebDomainMigration } from '../../src/migrations/web-domain-migrate.js'
import { applyRagIndexMigration, queueNodeRagCutoverBaseline } from '../../src/migrations/rag-index-migrate.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('生产 RAG Worker 从事实表和授权文件重建 PostgreSQL 的八类来源', {
  skip: !url && '需要隔离 PostgreSQL',
}, async () => {
  assert.ok(url)
  const schema = `rag_fs_${randomUUID().replaceAll('-', '')}`
  const directory = await mkdtemp(join(tmpdir(), 'gugu-rag-fs-postgres-'))
  const admin = new Pool({ connectionString: url, max: 1 })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 })
  let runtime: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
  const owner = randomUUID(), foreign = randomUUID()
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await applyAgentBaseMigration(pool)
    await applyWebDomainMigration(pool)
    await applyAgentRunMigration(pool)
    await pool.query(`INSERT INTO users(id,username,email,hashed_password)
      VALUES($1,'小北','north@example.test','synthetic'),($2,'小南','south@example.test','synthetic')`, [owner, foreign])
    await applyRagIndexMigration(pool)
    runtime = await createPostgresRuntime({ url, schema })
    await runtime.transaction(dataContext(owner), data => data.projects.create({ name: '接管项目' }))
    await pool.query(`INSERT INTO calendar_events (user_id,title,date,type,description,version,created_at)
      VALUES ($1,'接管日历','2026-11-18','event','日历正文',1,CURRENT_TIMESTAMP)`, [owner])
    const nodes = await pool.query<{ id: number }>(`INSERT INTO mind_nodes
      (user_id,kind,title,content_md,content_plain,origin,version,captured_at,created_at,updated_at) VALUES
      ($1,'note','接管便签','便签正文','便签正文','user',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ($1,'canvas_note','画布节点','画布正文','画布正文','user',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      RETURNING id`, [owner])
    const canvas = await pool.query<{ id: number }>(`INSERT INTO mind_maps (user_id,title,data_json,created_at,updated_at)
      VALUES ($1,'接管画布','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`, [owner])
    await pool.query(`INSERT INTO mind_canvas_items
      (user_id,canvas_id,node_id,x,y,z,collapsed,data_json,created_at,updated_at)
      VALUES ($1,$2,$3,0,0,0,false,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [owner, canvas.rows[0]!.id, nodes.rows[1]!.id])
    await pool.query(`INSERT INTO scheduled_tasks (user_id,name,payload,cron,channels,enabled,created_at,updated_at)
      VALUES ($1,'接管任务','定时任务正文','0 9 * * *','web',true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [owner])
    await pool.query(`INSERT INTO conversation_sessions (id,user_id,title,source,updated_at,baseline_message_seq)
      VALUES (1,$1,'接管历史','web',CURRENT_TIMESTAMP,0)`, [owner])
    await pool.query(`INSERT INTO conversation_messages (id,session_id,conversation_seq,role,content,created_at)
      VALUES (1,1,1,'user','历史对话正文',CURRENT_TIMESTAMP)`)
    await pool.query(`INSERT INTO memory_reflection_cursors
      (owner_user_id, platform, bot_id, scope_type, scope_id, scope_version, updated_at) VALUES
      ($1,'qq','bot-a','group','live',1,CURRENT_TIMESTAMP),
      ($1,'qq','bot-a','group','old',2,CURRENT_TIMESTAMP),
      ($2,'qq','bot-a','group','other',1,CURRENT_TIMESTAMP)`, [owner, foreign])
    await pool.query("INSERT INTO memory_scope_tombstones(owner_user_id,platform,bot_id,scope_type,scope_id) VALUES ($1,'qq','bot-a','group','old')", [owner])

    async function groupMemory(user: string, group: string, content: string) {
      const path = join(directory, user, '.agent', 'im', 'qq', 'bot-a', 'groups', group)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'profile.json'), JSON.stringify({ text: content }))
    }
    await groupMemory(owner, 'live', '当前群的授权记忆')
    await groupMemory(owner, 'old', '已删除群的记忆')
    await groupMemory(foreign, 'other', '其他用户的授权记忆')

    const knowledge = join(directory, owner, '.agent', 'knowledge')
    await mkdir(join(knowledge, 'entries'), { recursive: true })
    await writeFile(join(knowledge, '.timestamps-iso-v1'), '')
    await writeFile(join(knowledge, 'entries', 'entry.md'), [
      '---', 'id: entry', 'title: 生产索引知识', 'topic: 索引验收', 'keywords_json: []', 'description: 文件来源',
      `scope_json: ${JSON.stringify({ type: 'owner', owner_user_id: owner })}`,
      'source_json: {"type":"user","ref":"","label":"本地知识","checked_at":null}',
      'confidence: confirmed', 'version: 1', 'parent_id:', 'created_at: 2026-01-01T00:00:00.000000+00:00',
      'updated_at: 2026-02-03T04:05:06.123456+00:00', 'active: true', '---', '当前用户的知识正文', '',
    ].join('\n'))

    const { work } = createAgentRagRebuildWorker(runtime, {
      knowledgeStore: createLocalAgentKnowledgeReadStore(directory), memoryStorageRoot: directory,
    })
    assert.deepEqual(await queueNodeRagCutoverBaseline(pool), { status: 'queued', jobs: 16 })
    for (let count = 0; count < 16; count++) {
      const outcome = await work()
      if (outcome !== 'ready') {
        const failed = await pool.query("SELECT source_type, last_error_code FROM rag_index_jobs WHERE status='retrying'")
        assert.fail(`Worker 第 ${count + 1} 条任务返回 ${outcome}，重试来源 ${JSON.stringify(failed.rows)}`)
      }
    }
    assert.equal(await work(), 'idle')
    const reader = createSqlRagPersistentIndexReader(runtime.db, 'postgres')
    const current = await reader.snapshot(owner)
    for (const [source, text] of Object.entries({
      project: '接管项目', calendar: '日历正文', note: '便签正文', canvas: '画布正文',
      scheduled_task: '定时任务正文', conversation: '历史对话正文',
    })) {
      assert.ok(current.documents.some(doc => doc.source_type === source && doc.content?.includes(text)), source)
    }
    assert.ok(current.documents.some(doc => doc.source_type === 'knowledge' && doc.content === '当前用户的知识正文'))
    assert.deepEqual(current.documents.filter(doc => doc.source_type === 'memory').map(doc => doc.scope_id), ['live'])
    const other = await reader.snapshot(foreign)
    assert.deepEqual(other.documents.map(doc => [doc.source_type, doc.scope_id]), [['memory', 'other']])

    await pool.query("INSERT INTO memory_scope_tombstones(owner_user_id,platform,bot_id,scope_type,scope_id) VALUES ($1,'qq','bot-a','group','live')", [owner])
    await enqueueAgentRagRebuild(runtime.db, 'postgres', owner, 'memory')
    assert.equal(await work(), 'ready')
    const refreshed = await reader.snapshot(owner)
    assert.equal(refreshed.documents.some(doc => doc.source_type === 'memory'), false)
    assert.equal(refreshed.documents.length, current.documents.length - 1)
    assert.equal((await reader.snapshot(foreign)).documents.length, 1)

    const identity = { ownerId: owner, sessionId: '1', runId: 'pg-note-run' }
    const accessVersion = 'a'.repeat(64)
    await pool.query('UPDATE conversation_sessions SET active_run_id=$1 WHERE id=1 AND user_id=$2', [identity.runId, owner])
    await pool.query(`INSERT INTO agent_run_dispatch
      (user_id,session_id,run_id,state,message_id,nonce,payload,request_expires_at,token,fence,lease_expires_at)
      VALUES ($1,1,$2,'selected',1,$3,$3,now()+interval '1 minute','pg-note-lease',1,now()+interval '1 minute')`, [owner, identity.runId, Buffer.alloc(0)])
    const published: string[] = []
    const { toolRegistry } = createAuthorizedWebAgentProductionRagRunPorts({
      core: runtime, pool, storageRoot: directory,
      lease: { identity, token: 'pg-note-lease', fence: 1, mode: 'start', cancelRequested: false,
        input: { userMessageId: 1, locale: null, origin: null, accessVersion, v: 2, source: 'web' } },
      selection: { modelIdentity: 'synthetic', contextScopeKey: accessVersion, contextPolicy: { loadOwnerContext: true, memoryEnabled: false } },
      enabled: async () => true,
      noteWrites: createNoteWritePort(runtime, {
        timezone: 'Asia/Shanghai', now: () => new Date('2026-11-19T15:00:00Z'),
        async publish(event) { published.push(event.operation) },
      }),
    })
    assert.ok((await toolRegistry.capabilities(identity)).some(tool => tool.name === 'note_create'))
    assert.ok((await toolRegistry.capabilities(identity)).some(tool => tool.name === 'note_update'))
    const dispatch = (id: string, name: string, input: unknown) => toolRegistry.tools.dispatch({ id, name, input }, {
      identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      async execute(): Promise<never> { throw new Error('笔记工具不得调用执行器') },
    })
    const otherProject = await runtime.transaction(dataContext(foreign), data => data.projects.create({ name: '不属于当前用户的项目' }))
    const foreignRef = await dispatch('foreign-ref', 'note_create', { blocks: [{
      type: 'paragraph', content: [{ type: 'reference', ref_type: 'project', ref_id: otherProject.id, label: '引用项目' }],
    }] })
    assert.ok(foreignRef.kind === 'completed' && !foreignRef.successful && !foreignRef.mutated)
    assert.equal((foreignRef.value as { error: string }).error, '引用对象不存在')
    const createInput = { content: JSON.stringify([{ type: 'heading', content: [{ text: '工具笔记原标题' }] }]), captured_at: '2026-11-18' }
    const created = await dispatch('create-note', 'note_create', createInput)
    assert.ok(created.kind === 'completed' && created.successful && created.mutated, JSON.stringify(created))
    const createdNote = (created.value as { note: { node_id: number; captured_at: string } }).note
    assert.equal(new Date(createdNote.captured_at).toISOString(), '2026-11-18T04:00:00.000Z')
    const repeated = await dispatch('create-note', 'note_create', createInput)
    assert.ok(repeated.kind === 'completed' && repeated.successful && !repeated.mutated)
    assert.equal(await work(), 'ready')
    assert.ok((await reader.snapshot(owner)).documents.some(doc => doc.source_type === 'note' && doc.content?.includes('工具笔记原标题')))

    const editInput = (expected: string) => ({ node_id: createdNote.node_id,
      line_edits: [{ target_lines: '1', content: '# 工具笔记新标题', expected }] })
    const mixed = await dispatch('mixed-note', 'note_update', { ...editInput('# 工具笔记原标题'), append_markdown: '不得一并追加' })
    assert.ok(mixed.kind === 'completed' && !mixed.successful && !mixed.mutated)
    assert.match((mixed.value as { next_action: string }).next_action, /普通文字追加格式/)
    const stale = await dispatch('stale-note', 'note_update', editInput('# 过时内容'))
    assert.ok(stale.kind === 'completed' && !stale.successful && !stale.mutated)
    const updated = await dispatch('edit-note', 'note_update', editInput('# 工具笔记原标题'))
    assert.ok(updated.kind === 'completed' && updated.successful && updated.mutated, JSON.stringify(updated))
    const replayed = await dispatch('edit-note', 'note_update', editInput('# 工具笔记原标题'))
    assert.ok(replayed.kind === 'completed' && replayed.successful && !replayed.mutated)
    assert.equal(await work(), 'ready')
    const noteDocuments = (await reader.snapshot(owner)).documents.filter(doc => doc.source_type === 'note')
    assert.ok(noteDocuments.some(doc => doc.content?.includes('工具笔记新标题')))
    assert.ok(!noteDocuments.some(doc => doc.content?.includes('工具笔记原标题')))
    assert.deepEqual((await pool.query('SELECT action FROM undo_operations ORDER BY action')).rows, [{ action: 'create' }, { action: 'update' }])
    assert.deepEqual(published, ['create', 'update'])
    await pool.query("UPDATE agent_run_dispatch SET state='done' WHERE run_id=$1", [identity.runId])
    const revoked = await dispatch('revoked-note', 'note_update', { node_id: createdNote.node_id, append_markdown: '撤权后不能写' })
    assert.ok(revoked.kind === 'completed' && !revoked.successful)
    assert.equal(await work(), 'idle')

    await rm(join(knowledge, '.timestamps-iso-v1'))
    await enqueueAgentRagRebuild(runtime.db, 'postgres', owner, 'knowledge')
    assert.equal(await work(), 'retrying', '非空旧知识目录仍需先完成时间格式迁移')
    assert.ok((await reader.snapshot(owner)).documents.some(doc => doc.source_type === 'knowledge'))
  } finally {
    await runtime?.close()
    await pool.end()
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await admin.end()
    await rm(directory, { recursive: true, force: true })
  }
})
