import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createLocalAgentRememberPort } from '../../../src/modules/agent/tools/memory/write.js'
import { createAgentToolRegistry, filterConfiguredWebAgentTools } from '../../../src/modules/agent/tools/registry.js'
import { createAgentRagRebuildWorker } from '../../../src/modules/agent/rag/rebuild.js'
import { applyRagIndexMigration } from '@gugu/database/postgres/migrations/0011_rag_index'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('remember 读写真实档案，提交失败后恢复同一写入、向量失效和索引队列', { skip: !url }, async () => {
  const schema = `gugu_remember_${randomUUID().replaceAll('-', '')}`
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-remember-'))
  const admin = new Pool({ connectionString: url })
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: url!, schema })
  const ownerId = randomUUID(), otherId = randomUUID()
  const identity = { ownerId, sessionId: '1', runId: 'remember-run' }
  const directory = path.join(root, ownerId, '.agent')
  const patternFile = path.join(directory, 'pattern.json')
  const vectorFile = path.join(directory, 'pattern_vec.json')
  const profileFile = path.join(directory, 'profile.json')
  const modelTag = 'openai:test:default'
  const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'))
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const ddl = tablesSql('postgres')
    await pool.query([ddl.receipts, ddl.ragJobs,
      'CREATE TABLE users(id uuid PRIMARY KEY)',
      'CREATE TABLE data_import_jobs(id uuid PRIMARY KEY,user_id uuid NOT NULL,mode text NOT NULL,status text NOT NULL,updated_at timestamptz NOT NULL)',
      'CREATE TABLE memory_reflection_cursors(id integer PRIMARY KEY,owner_user_id uuid,scope_type text,scope_id text,platform text,bot_id text)',
    ].join(';\n'))
    await pool.query('INSERT INTO users VALUES ($1),($2)', [ownerId, otherId])
    await applyRagIndexMigration(pool)
    await mkdir(directory, { recursive: true })
    await mkdir(path.join(root, otherId, '.agent', 'memories'), { recursive: true })
    const other = path.join(root, otherId, '.agent', 'memories', 'pattern.json')
    await writeFile(other, JSON.stringify([{ id: 'other', text: '另一用户的偏好' }]))
    await writeFile(path.join(directory, 'facts.json'), JSON.stringify([{ id: 'legacy', text: '过时旧档案' }]))
    await writeFile(patternFile, JSON.stringify([
      { id: 'drop', text: '工作日上午整理项目资料', kind: 'observed', ts: 1700000000, conf: 0.9, imp: 3 },
      { id: 'keep', text: '晚上优先读设计文档', kind: 'observed', ts: 1700000000, conf: 0.9, imp: 3 },
    ]))
    await writeFile(vectorFile, JSON.stringify({ drop: { t: modelTag, v: [1] }, keep: { t: modelTag, v: [2] } }))
    await writeFile(profileFile, JSON.stringify([{ text: '独立的画像条目', type: 'note', ts: 1700000000 }]))
    const { work } = createAgentRagRebuildWorker(core, { memoryStorageRoot: root })
    await pool.query(`INSERT INTO rag_index_jobs
      (user_id,source_type,source_id,pending_source_ids,version,operation,status,generation,completed_generation,attempts,next_attempt_at,created_at,updated_at)
      VALUES ($1,'memory','','[]','','refresh','queued',1,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [ownerId])
    assert.equal(await work(), 'ready')
    const indexed = async () => (await pool.query('SELECT content FROM knowledge_index_entries WHERE owner_user_id=$1 AND deleted_at IS NULL', [ownerId])).rows.map(row => row.content).join('\n')
    assert.match(await indexed(), /工作日上午整理项目资料/u)
    let canWrite = true
    let deferredChecks = 0
    const embedded: string[] = []
    const registry = () => createAgentToolRegistry({ core, authorize: async candidate => candidate.ownerId === ownerId,
      time: { now: () => new Date(1700000123000), timezone: async () => 'UTC' },
      remember: createLocalAgentRememberPort({ core, storageRoot: root,
        async authorize(_tx, candidate) {
          if (candidate.toolCallId === 'before-archive') return deferredChecks++ === 0
          return canWrite && candidate.ownerId === ownerId
        },
        embedding: {
          async resolve(owner) {
            assert.equal(owner, ownerId)
            return { provider: 'openai', model: 'test', dimensions: 0, baseUrl: 'https://embedding.example/v1', apiKey: 'synthetic' }
          },
          createTransport: () => ({
            async request(request) {
              assert.equal(request.url, 'https://embedding.example/v1/embeddings')
              embedded.push(String(request.body.input))
              return { status: 200, headers: {}, async cancel() {},
                body: (async function* () { yield Buffer.from('{"data":[{"embedding":[3]}]}') })() }
            },
          }),
        },
      }) })
    assert.deepEqual(filterConfiguredWebAgentTools(['remember', 'unknown_tool']), ['remember'])
    const scope = { identity, roundId: '1', signal: new AbortController().signal, resolution: null,
      async execute(): Promise<never> { throw new Error('记忆工具不调用进程') } }
    const call = { id: 'remember', name: 'remember', input: {
      target: 'pattern', remove: ['上午整理项目资料'], text: '周末优先整理出行计划',
    } }
    const denied = await registry().tools.dispatch(call, { ...scope, identity: { ...identity, ownerId: otherId } })
    assert.ok(denied.kind === 'completed' && !denied.successful)
    canWrite = false
    const expired = await registry().tools.dispatch(call, scope)
    assert.ok(expired.kind === 'completed' && !expired.successful)
    canWrite = true
    await pool.query("ALTER TABLE rag_index_jobs ADD CONSTRAINT block_memory_queue CHECK(status <> 'queued')")
    assert.equal((await registry().tools.dispatch(call, scope)).kind, 'unknown')
    const after = await readJson(patternFile)
    assert.deepEqual(after.map((row: { text: string }) => row.text), ['晚上优先读设计文档', '周末优先整理出行计划'])
    assert.deepEqual(await readJson(vectorFile), { keep: { t: modelTag, v: [2] } })
    assert.deepEqual(embedded, [])
    assert.match(await indexed(), /独立的画像条目/u)
    assert.doesNotMatch(await indexed(), /工作日上午整理项目资料/u)
    await pool.query('ALTER TABLE rag_index_jobs DROP CONSTRAINT block_memory_queue')
    const recovered = await registry().tools.reconcile(call, { ...identity, roundId: scope.roundId })
    assert.ok(recovered.kind === 'completed' && recovered.successful)
    assert.deepEqual(recovered.value, { success: true, target: 'pattern', added: 1, removed: 1, remembered: '周末优先整理出行计划' })
    assert.deepEqual(await registry().tools.dispatch(call, scope), { ...recovered, mutated: false })
    assert.deepEqual(embedded, ['周末优先整理出行计划'])
    assert.deepEqual(await readJson(vectorFile), { keep: { t: modelTag, v: [2] }, [after[1].id]: { t: modelTag, v: [3] } })
    assert.deepEqual(await readJson(patternFile), after)
    assert.deepEqual(await readdir(path.join(directory, '.remember')), [])
    assert.deepEqual(await readJson(other), [{ id: 'other', text: '另一用户的偏好' }])
    const receipts = await pool.query('SELECT result_json FROM core_operation_receipts')
    assert.equal(receipts.rowCount, 2)
    assert.doesNotMatch(JSON.stringify(receipts.rows), /工作日|周末|文档/u)
    assert.equal(await work(), 'ready')
    const text = await indexed()
    assert.match(text, /周末优先整理出行计划/u)
    assert.doesNotMatch(text, /工作日上午整理项目资料|过时旧档案/u)

    await unlink(vectorFile)
    await symlink(other, vectorFile)
    const stale = { ...call, id: 'stale-pattern', input: { target: 'pattern', text: '本次暂存计划' } }
    assert.equal((await registry().tools.dispatch(stale, scope)).kind, 'unknown')
    assert.deepEqual(await readJson(patternFile), after)
    const advanced = [...after, { id: 'newer', text: '并发保存的新版本', kind: 'observed', ts: 1700000124, conf: 0.9, imp: 3 }]
    await writeFile(patternFile, JSON.stringify(advanced))
    await unlink(vectorFile)
    await writeFile(vectorFile, '{}')
    const refused = await registry().tools.reconcile(stale, { ...identity, roundId: scope.roundId })
    assert.ok(refused.kind === 'completed' && !refused.successful && !refused.mutated)
    assert.deepEqual(await readJson(patternFile), advanced)
    assert.equal(await work(), 'ready')
    assert.match(await indexed(), /并发保存的新版本/u)
    assert.doesNotMatch(await indexed(), /本次暂存计划/u)

    await writeFile(profileFile, JSON.stringify(['旧格式画像', { id: 'old', type: 'legacy', text: '保留的画像' }]))
    const profile = await registry().tools.dispatch({ ...call, id: 'profile', input: {
      remove: ['旧格式画像'], text: '偏好简明文档', type: 'preference',
    } }, scope)
    assert.ok(profile.kind === 'completed' && profile.successful)
    assert.deepEqual(await readJson(profileFile), [
      { type: 'note', text: '保留的画像', ts: null },
      { type: 'preference', text: '偏好简明文档', ts: 1700000123 },
    ])
    const profileBeforeArchive = await readFile(profileFile, 'utf8')
    const beforeArchive = { ...call, id: 'before-archive', input: { text: '旧计划不应在替换后恢复' } }
    assert.equal((await registry().tools.dispatch(beforeArchive, scope)).kind, 'unknown')
    const archiveId = randomUUID()
    await pool.query("INSERT INTO data_import_jobs VALUES ($1,$2,'replace','applying',clock_timestamp())", [archiveId, ownerId])
    const blocked = await registry().tools.dispatch({ ...beforeArchive, id: 'during-archive' }, scope)
    assert.ok(blocked.kind === 'completed' && !blocked.successful)
    assert.partialDeepStrictEqual(blocked.value, { error: '档案迁移期间不能更新记忆', tool: 'remember' })
    const recoveryIdentity = { ...identity, roundId: scope.roundId }
    assert.equal((await registry().tools.reconcile(beforeArchive, recoveryIdentity)).kind, 'unknown')
    await pool.query("UPDATE data_import_jobs SET status='completed',updated_at=clock_timestamp() WHERE id=$1", [archiveId])
    deferredChecks = 0
    const afterArchive = await registry().tools.reconcile(beforeArchive, recoveryIdentity)
    assert.ok(afterArchive.kind === 'completed' && !afterArchive.successful && !afterArchive.mutated)
    assert.equal(await readFile(profileFile, 'utf8'), profileBeforeArchive)
  } finally {
    await core.close()
    await pool.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally { await admin.end(); await rm(root, { recursive: true, force: true }) }
  }
})
