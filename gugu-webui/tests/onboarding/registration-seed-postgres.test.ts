import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createPostgresRegistrationSeedOperations } from '../../src/domains/onboarding/persistence/registration-seed-postgres.js'
import { createRegistrationSeeder, type RegistrationSeedPlan } from '../../src/domains/onboarding/registration-seed.js'

function plan(): RegistrationSeedPlan {
  return {
    project: {
      name: '从这里开始', status: 'active', currentStage: 's0',
      startDate: '2026-11-14', deadline: '2026-11-17',
      stages: [{ key: 's0', label: '准备', todos: [{ id: 's0t0', text: '看看这里', done: false }] }],
    },
    calendarEvent: { title: '和咕咕的第一天', date: '2026-11-14', type: 'event' },
    files: [
      { space: 'project', projectRef: 'seed_project', displayName: '第一份记录', ext: 'md', mimeType: 'text/markdown', data: Buffer.from('# 第一份记录\n') },
      { space: 'project', projectRef: 'seed_project', displayName: '可以删掉我', ext: 'md', mimeType: 'text/markdown', data: Buffer.from('# 示例文件\n') },
    ],
    seedState: { seeded: true, project_name: '从这里开始' },
    guideState: { enabled: true, version: 1, current_step: 'locale', completed_steps: [], dismissed: false, completed_at: null },
  }
}

function fakePool(options: { failOnFileInsert?: number; failOnStateUpdate?: boolean; seeded?: boolean } = {}) {
  let state: Record<string, unknown> = options.seeded
    ? { seed: { seeded: true, project_id: 7, project_name: '旧项目' }, guide: { enabled: false } }
    : { seed: { seeded: false, project_id: null, project_name: null }, guide: { enabled: false } }
  let fileInserts = 0
  let projectInserts = 0
  let eventInserts = 0
  let commits = 0
  let rollbacks = 0
  let nextFileId = 10
  const client = {
    async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        if (sql === 'ROLLBACK') rollbacks++
        return { rows: [], rowCount: 0 } as never
      }
      if (sql === 'COMMIT') { commits++; return { rows: [], rowCount: 0 } as never }
      if (sql.includes('INSERT INTO onboarding_state')) return { rows: [], rowCount: 0 } as never
      if (sql.includes('SELECT state FROM onboarding_state')) return { rows: [{ state }] as unknown as Row[], rowCount: 1 }
      if (sql.includes('INSERT INTO projects')) { projectInserts++; return { rows: [{ id: 42 }] as unknown as Row[], rowCount: 1 } }
      if (sql.includes('INSERT INTO calendar_events')) { eventInserts++; return { rows: [], rowCount: 1 } as never }
      if (sql.startsWith('SELECT id,name,color')) return { rows: [{ id: 42, name: '从这里开始', color: null, year: '2026', month: '11' }] as unknown as Row[], rowCount: 1 }
      if (sql.includes('SELECT storage_limit_bytes FROM users')) return { rows: [{ storage_limit_bytes: null }] as unknown as Row[], rowCount: 1 }
      if (sql.includes('SELECT used_bytes,reserved_bytes,limit_bytes FROM storage_quota_ledgers'))
        return { rows: [{ used_bytes: 0, reserved_bytes: 0, limit_bytes: Number.MAX_SAFE_INTEGER }] as unknown as Row[], rowCount: 1 }
      if (sql.includes('SELECT used_bytes,reserved_bytes FROM storage_quota_ledgers'))
        return { rows: [{ used_bytes: 0, reserved_bytes: 0 }] as unknown as Row[], rowCount: 1 }
      if (sql.includes('SELECT 1 FROM files WHERE user_id=$1 AND storage_key=$2')) return { rows: [], rowCount: 0 } as never
      if (sql.includes('INSERT INTO files')) {
        fileInserts++
        if (options.failOnFileInsert === fileInserts) throw new Error('synthetic file insert failure')
        return { rows: [{ id: nextFileId++, size_bytes: values[11] }] as unknown as Row[], rowCount: 1 }
      }
      if (sql.includes('UPDATE storage_quota_ledgers')) return { rows: [], rowCount: 1 } as never
      if (sql.includes('INSERT INTO storage_quota_events')) return { rows: [], rowCount: 1 } as never
      if (sql.includes('UPDATE onboarding_state SET state=')) {
        if (options.failOnStateUpdate) throw new Error('synthetic onboarding state failure')
        state = JSON.parse(String(values[1])) as Record<string, unknown>
        return { rows: [], rowCount: 1 } as never
      }
      throw new Error(`Unexpected query in test fixture: ${sql}`)
    },
    release() {},
  }
  const pool = { async connect() { return client } } as unknown as Pick<Pool, 'connect'>
  return { pool, stats: () => ({ fileInserts, projectInserts, eventInserts, commits, rollbacks, state }) }
}

async function collectFiles(root: string): Promise<string[]> {
  const found: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else found.push(target)
    }
  }
  await visit(root)
  return found
}

test('注册播种在同一事务创建项目、首日活动、Local 文件与状态，重放保持幂等', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-seed-adapter-test-'))
  try {
    const db = fakePool()
    const applySeed = createPostgresRegistrationSeedOperations(db.pool, { storageRoot: root })
    assert.equal(await applySeed('00000000-0000-4000-8000-000000000001', plan()), 'applied')
    assert.deepEqual(db.stats(), {
      fileInserts: 2, projectInserts: 1, eventInserts: 1, commits: 1, rollbacks: 0,
      state: {
        seed: { seeded: true, project_id: 42, project_name: '从这里开始' },
        guide: { enabled: true, version: 1, current_step: 'locale', completed_steps: [], dismissed: false, completed_at: null },
      },
    })
    const files = await collectFiles(root)
    assert.equal(files.length, 2)
    assert.deepEqual((await Promise.all(files.map((file) => readFile(file, 'utf8')))).sort(), ['# 示例文件\n', '# 第一份记录\n'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('注册播种编排生成本地化计划并提交到 PostgreSQL 端口与 Local 文件库', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-seed-end-to-end-test-'))
  try {
    const db = fakePool()
    const applySeed = createPostgresRegistrationSeedOperations(db.pool, { storageRoot: root })
    const seed = createRegistrationSeeder({ applySeed, async surpriseMp3() { return null } }, {
      now: () => new Date(2026, 10, 14, 12), random: () => 0,
    })
    await seed('00000000-0000-4000-8000-000000000001', 'en-US')
    assert.equal(db.stats().projectInserts, 1)
    assert.equal(db.stats().eventInserts, 1)
    assert.equal(db.stats().fileInserts, 2)
    assert.equal(db.stats().commits, 1)
    assert.deepEqual(await Promise.all((await collectFiles(root)).sort().map((file) => readFile(file, 'utf8'))), [
      '# To my future self\n\n> May this space one day be filled\n> with ideas, plans,\n> and many conversations.\n\nFor today, let’s start with this page 🌱\n\n---\n\n*—— Gugu*\n',
      '# You can delete me\n\nI’m just a sample file 😊\n\nKeep, edit, or delete me—anything is fine.\n',
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('第二个 Local 文件插入失败时回滚事务并删除先前已写入的文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-seed-rollback-test-'))
  try {
    const db = fakePool({ failOnFileInsert: 2 })
    const applySeed = createPostgresRegistrationSeedOperations(db.pool, { storageRoot: root })
    await assert.rejects(applySeed('00000000-0000-4000-8000-000000000001', plan()), /synthetic file insert failure/)
    assert.deepEqual(db.stats(), {
      fileInserts: 2, projectInserts: 1, eventInserts: 1, commits: 0, rollbacks: 1,
      state: { seed: { seeded: false, project_id: null, project_name: null }, guide: { enabled: false } },
    })
    assert.deepEqual(await collectFiles(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('已播种用户不重复创建任何记录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-seed-idempotent-test-'))
  try {
    const db = fakePool({ seeded: true })
    const applySeed = createPostgresRegistrationSeedOperations(db.pool, { storageRoot: root })
    assert.equal(await applySeed('00000000-0000-4000-8000-000000000001', plan()), 'already_seeded')
    assert.deepEqual(db.stats(), {
      fileInserts: 0, projectInserts: 0, eventInserts: 0, commits: 1, rollbacks: 0,
      state: { seed: { seeded: true, project_id: 7, project_name: '旧项目' }, guide: { enabled: false } },
    })
    assert.deepEqual(await collectFiles(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('可选惊喜 MP3 写入用户个人 Local 空间', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-seed-mp3-test-'))
  const ownerId = '00000000-0000-4000-8000-000000000001'
  try {
    const db = fakePool()
    const applySeed = createPostgresRegistrationSeedOperations(db.pool, { storageRoot: root })
    const base = plan()
    const withMp3: RegistrationSeedPlan = {
      ...base,
      files: [...base.files, {
        space: 'personal', projectRef: null, displayName: 'synthetic-surprise',
        ext: 'mp3', mimeType: 'audio/mpeg', data: Buffer.from('synthetic audio'),
      }],
    }
    assert.equal(await applySeed(ownerId, withMp3), 'applied')
    const files = await collectFiles(root)
    const mp3 = files.find((file) => file.endsWith(path.join('个人文件', 'synthetic-surprise.mp3')))
    assert.ok(mp3)
    assert.equal(await readFile(mp3!, 'utf8'), 'synthetic audio')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('引导状态写入失败时清理全部 Local 文件并回滚项目与日历事务', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-seed-state-rollback-test-'))
  try {
    const db = fakePool({ failOnStateUpdate: true })
    const applySeed = createPostgresRegistrationSeedOperations(db.pool, { storageRoot: root })
    await assert.rejects(applySeed('00000000-0000-4000-8000-000000000001', plan()), /synthetic onboarding state failure/)
    assert.deepEqual(db.stats(), {
      fileInserts: 2, projectInserts: 1, eventInserts: 1, commits: 0, rollbacks: 1,
      state: { seed: { seeded: false, project_id: null, project_name: null }, guide: { enabled: false } },
    })
    assert.deepEqual(await collectFiles(root), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
