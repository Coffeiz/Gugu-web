import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createDurableFileSkillDeletePort, createDurableFileSkillManagementPort, createFileSkillManagementWriteTools, readFileSkillDeleteTarget } from '@gugu/core/tools'
import { createUserSkillBundle, cutoverLegacySkillBundles, readUserSkillBundle } from '@gugu/core/skills'
import { createRuntimeUndoTransactionPort } from '@gugu/core/undo'
import { createWebAgentSkillDeleteStorage, createWebAgentSkillMutationAdapter } from '../../src/modules/skills/agent-storage.js'
import { createHostCoreUndoOperations } from '../../src/modules/undo/service.js'
import { createLocalSkillUndoStorage } from '../../src/modules/skills/undo-storage.js'
import { migrateWebSkillOwners } from '../../src/modules/skills/migrate.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('Web Agent 文件技能创建、更新、收据重放和撤销使用同一 PG 事务', { skip: !url && '需要隔离 PostgreSQL' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-agent-skill-pg-'))
  const schema = `agent_skill_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(tablesSql('postgres').receipts)
    await pool.query(`CREATE TABLE undo_operations(id text PRIMARY KEY,user_id uuid NOT NULL,undo_context_id text NOT NULL,
      group_id text NOT NULL,resource text NOT NULL,action text NOT NULL,target_refs json NOT NULL,before_state json NOT NULL,
      after_state json NOT NULL,base_versions json NOT NULL,artifact_refs json NOT NULL,actor_type text NOT NULL,status text NOT NULL,
      created_at timestamptz NOT NULL,expires_at timestamptz,undone_at timestamptz,failure_code text)`)
    const adapter = createWebAgentSkillMutationAdapter({ dataRoot: root, async knownTools() { return new Set(['read_file']) }, async publish() {} })
    const port = createDurableFileSkillManagementPort({ core, adapter, async authorize() { return true } })
    const identity = { ownerId: randomUUID(), sessionId: '1', runId: 'test-run' }
    const scope = { identity, roundId: 'round', signal: new AbortController().signal } as Parameters<typeof port.execute>[2]
    const create = { skill_name: '示例', description_short: '描述', body: '初版', related_tools: ['read_file'], managed_by: 'assistant' as const }
    const createCall = { id: 'create', name: 'create_skill', input: create }
    const [createTool, updateTool] = createFileSkillManagementWriteTools(port)
    assert.equal(createTool!.validate(create).success, true)
    const created = await createTool!.execute(create, scope, createCall)
    assert.ok(created.kind === 'completed' && created.successful)
    const slug = (created.value as { skill: { id: string } }).skill.id
    assert.equal((await readUserSkillBundle(root, identity.ownerId, slug)).body, '初版')
    assert.deepEqual(await createTool!.execute(create, scope, createCall), { ...created, mutated: false })
    const update = { id: slug, body: '新版' }, updateCall = { id: 'update', name: 'update_skill', input: update }
    assert.ok((await updateTool!.execute(update, scope, updateCall)).kind === 'completed')
    const context = `agent:${identity.sessionId}:${identity.runId}`
    const records = await pool.query<{ id: string; action: string }>("SELECT id,action FROM undo_operations WHERE user_id=$1 ORDER BY created_at", [identity.ownerId])
    assert.deepEqual(records.rows.map(row => row.action), ['install', 'update'])
    const operations = createHostCoreUndoOperations(pool, createRuntimeUndoTransactionPort(core), async () => {}, undefined, undefined, createLocalSkillUndoStorage(root))
    await operations.apply(identity.ownerId, context, records.rows[1]!.id, 'undo')
    assert.equal((await readUserSkillBundle(root, identity.ownerId, slug)).body, '初版')
    await operations.apply(identity.ownerId, context, records.rows[1]!.id, 'redo')
    assert.equal((await readUserSkillBundle(root, identity.ownerId, slug)).body, '新版')
    await pool.query(`CREATE FUNCTION reject_skill_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt error'; END $$;
      CREATE TRIGGER reject_skill_receipt BEFORE INSERT ON core_operation_receipts FOR EACH ROW EXECUTE FUNCTION reject_skill_receipt()` )
    const retry = { id: slug, body: '恢复版本' }, retryCall = { id: 'retry', name: 'update_skill', input: retry }
    assert.deepEqual(await updateTool!.execute(retry, scope, retryCall), { kind: 'unknown' })
    assert.equal((await readUserSkillBundle(root, identity.ownerId, slug)).body, '恢复版本')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM undo_operations')).rows[0].n), 2)
    await pool.query('DROP TRIGGER reject_skill_receipt ON core_operation_receipts')
    const recovered = await updateTool!.execute(retry, scope, retryCall)
    assert.ok(recovered.kind === 'completed' && recovered.successful)
    assert.equal((await readUserSkillBundle(root, identity.ownerId, slug)).body, '恢复版本')
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM undo_operations')).rows[0].n), 3)
    const confirmation = { async claim() { return true } } as unknown as Parameters<typeof createDurableFileSkillDeletePort>[0]['confirmation']
    const deletePort = createDurableFileSkillDeletePort({ core, dataRoot: root, confirmation, async authorize() { return true },
      storage: createWebAgentSkillDeleteStorage({ dataRoot: root, async publish() {} }) })
    const deleteCall = { id: 'delete', name: 'delete_skill', input: { id: slug } }
    const target = await readFileSkillDeleteTarget(root, identity.ownerId, slug)
    const deleted = await deletePort.remove({ target, scope, call: deleteCall, claim: {} as never })
    assert.ok(deleted.kind === 'completed' && deleted.successful)
    await assert.rejects(readUserSkillBundle(root, identity.ownerId, slug), { code: 'ENOENT' })
    const deletion = await pool.query<{ id: string }>("SELECT id FROM undo_operations WHERE action='remove' AND user_id=$1", [identity.ownerId])
    assert.equal(deletion.rowCount, 1)
    await operations.apply(identity.ownerId, context, deletion.rows[0]!.id, 'undo')
    assert.equal((await readUserSkillBundle(root, identity.ownerId, slug)).body, '恢复版本')
    await operations.apply(identity.ownerId, context, deletion.rows[0]!.id, 'redo')
    await assert.rejects(readUserSkillBundle(root, identity.ownerId, slug), { code: 'ENOENT' })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE user_skills(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,owner_id uuid,skill_id text,name text,description_short text,description_long text,category text,
        related_tools jsonb,body text,enabled boolean,managed_by text,source text);
      CREATE TABLE conversation_sessions(id integer PRIMARY KEY,user_id uuid);
      CREATE TABLE conversation_messages(id integer PRIMARY KEY,session_id integer,references_json jsonb);
      CREATE TABLE mind_nodes(id integer PRIMARY KEY,user_id uuid,content_md text,version integer);
      CREATE TABLE conversation_pending_queues(user_id uuid,queue_id text,items jsonb)` )
    const other = randomUUID()
    await pool.query('INSERT INTO users VALUES($1),($2)', [identity.ownerId, other])
    await pool.query(`INSERT INTO user_skills(owner_id,skill_id,name,description_short,description_long,category,related_tools,body,enabled,managed_by,source) VALUES
      ($1,'U1','旧技能','描述',NULL,'personal','[]','旧正文',FALSE,'user','user'),
      ($2,'U1','其他用户','描述',NULL,'personal','[]','其他正文',TRUE,'user','user')`, [identity.ownerId, other])
    await pool.query('INSERT INTO conversation_sessions VALUES(1,$1),(2,$2)', [identity.ownerId, other])
    const refs = JSON.stringify([{ type: 'skill', id: 'U1', label: '旧技能' }, { type: 'skill', id: 1, label: '旧技能' }])
    await pool.query('INSERT INTO conversation_messages VALUES(1,1,$1),(2,2,$1)', [refs])
    await pool.query("INSERT INTO mind_nodes VALUES(1,$1,'[[skill:1|旧技能]]',1),(2,$2,'[[skill:1|其他用户]]',1)", [identity.ownerId, other])
    await pool.query('INSERT INTO conversation_pending_queues VALUES($1,$2,$3)', [identity.ownerId, 'draft', JSON.stringify([{ key: 1, references: [{ type: 'skill', id: 'U1', label: '旧技能' }] }])])
    assert.deepEqual(await cutoverLegacySkillBundles({ db: core.db, backend: 'postgres', dataRoot: root, ownerId: identity.ownerId }),
      [{ slug: 'u1', enabled: false, created: true }])
    assert.equal((await readUserSkillBundle(root, identity.ownerId, 'u1')).body, '旧正文')
    const sources = await pool.query('SELECT owner_id::text,source FROM user_skills ORDER BY owner_id')
    assert.equal(sources.rows.find(row => row.owner_id === identity.ownerId)?.source, 'migrated')
    assert.equal(sources.rows.find(row => row.owner_id === other)?.source, 'user')
    const messages = await pool.query('SELECT id,references_json FROM conversation_messages ORDER BY id')
    assert.deepEqual(messages.rows[0].references_json.map((ref: { id: string }) => ref.id), ['u1', 'u1'])
    assert.deepEqual(messages.rows[1].references_json, JSON.parse(refs))
    assert.deepEqual((await pool.query('SELECT content_md,version FROM mind_nodes ORDER BY id')).rows,
      [{ content_md: '[[skill:u1|旧技能]]', version: 2 }, { content_md: '[[skill:1|其他用户]]', version: 1 }])
    assert.equal((await pool.query('SELECT items FROM conversation_pending_queues')).rows[0].items[0].references[0].id, 'u1')
    assert.deepEqual(await cutoverLegacySkillBundles({ db: core.db, backend: 'postgres', dataRoot: root, ownerId: identity.ownerId }), [])
    const conflict = '---\nname: 已有目录\ndescription: 保留\n---\n已有内容'
    await createUserSkillBundle(root, other, 'u1', conflict)
    await assert.rejects(migrateWebSkillOwners(core, root), { code: 'conflict' })
    assert.equal((await readUserSkillBundle(root, other, 'u1')).source, conflict)
    assert.equal((await pool.query('SELECT source FROM user_skills WHERE owner_id=$1', [other])).rows[0].source, 'user')
    await rm(join(root, other, '.agent', 'skills', 'u1'), { recursive: true })
    await migrateWebSkillOwners(core, root)
    assert.equal((await readUserSkillBundle(root, other, 'u1')).body, '其他正文')
    assert.equal((await pool.query('SELECT source FROM user_skills WHERE owner_id=$1', [other])).rows[0].source, 'migrated')
    await migrateWebSkillOwners(core, root)
  } finally {
    await core.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
