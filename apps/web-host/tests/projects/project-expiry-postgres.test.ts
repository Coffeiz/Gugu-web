import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Pool } from 'pg'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readdir } from 'node:fs/promises'
import { recoverProjectExpiryJournal } from '../../src/modules/projects/lifecycle/expiry.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('隔离数据库中锁被占用时跳过恢复，释放后处理部分清理日志', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `expiry_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-pg-'))
  const owner = randomUUID(), id = randomUUID()
  const directory = path.join(root, owner, 'trash'), file = path.join(directory, 'a')
  const staged = `${file}.gugu-purge-${id}`
  try {
    await pool.query('CREATE TABLE projects(id int PRIMARY KEY,user_id uuid)')
    await pool.query('CREATE TABLE files(id int PRIMARY KEY,user_id uuid,path text)')
    await pool.query('CREATE TABLE project_expiry_journals(id uuid PRIMARY KEY,user_id uuid,project_id int,entries json,created_at timestamptz)')
    await pool.query('INSERT INTO projects VALUES(1,$1)', [owner])
    await pool.query('INSERT INTO files VALUES(2,$1,$2)', [owner, `${owner}/trash/a`])
    await pool.query('INSERT INTO project_expiry_journals VALUES($1,$2,1,$3,CURRENT_TIMESTAMP)', [id, owner, JSON.stringify([{ id: 2, path: `${owner}/trash/a` }])])
    await mkdir(directory, { recursive: true })
    await writeFile(staged, '旧文件')
    const lock = await pool.connect()
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext('gugu-project-expiry:' || current_schema()))")
      assert.equal(await recoverProjectExpiryJournal(pool, root), 'busy')
      await lock.query("SELECT pg_advisory_unlock(hashtext('gugu-project-expiry:' || current_schema()))")
      assert.equal(await recoverProjectExpiryJournal(pool, root), true)
    } finally { lock.release() }
    assert.equal(await readFile(file, 'utf8'), '旧文件')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_expiry_journals')).rows[0].n, 0)
    await pool.query('DELETE FROM files')
    await pool.query('DELETE FROM projects')
    await pool.query('INSERT INTO project_expiry_journals VALUES($1,$2,1,$3,CURRENT_TIMESTAMP)', [id, owner, JSON.stringify([{ id: 2, path: `${owner}/trash/a` }, { id: 3, path: `${owner}/trash/missing` }])])
    await writeFile(staged, '待清理')
    let recovered = false
    for (let i = 0; i < 100 && !recovered; i++) {
      recovered = (await recoverProjectExpiryJournal(pool, root)) === true
      if (!recovered) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(recovered, true)
    assert.equal(await readFile(file, 'utf8'), '旧文件')
    await assert.rejects(readFile(staged))
    assert.equal(await recoverProjectExpiryJournal(pool, root), false)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})

test('清理进程在暂存后崩溃，恢复后可重新清理并保留未登记文件', { skip: !url, timeout: 30000 }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `expiry_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 2 })
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-expiry-crash-'))
  const owner = randomUUID(), directory = path.join(root, owner, 'trash'), file = path.join(directory, 'a')
  let child: ReturnType<typeof spawn> | undefined
  try {
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE projects(id int PRIMARY KEY,user_id uuid,deleted_at timestamptz);
      CREATE TABLE files(id int PRIMARY KEY,user_id uuid,project_id int REFERENCES projects(id) ON DELETE CASCADE,path text);
      CREATE TABLE calendar_events(id int PRIMARY KEY,user_id uuid,project_id int);
      CREATE TABLE scheduled_tasks(id int PRIMARY KEY,user_id uuid,event_id int);
      CREATE TABLE rag_index_jobs(id bigserial PRIMARY KEY,user_id uuid NOT NULL,source_type text NOT NULL,source_id text NOT NULL,pending_source_ids json,version text NOT NULL,operation text NOT NULL,status text NOT NULL,generation int NOT NULL,completed_generation int NOT NULL,attempts int NOT NULL,next_attempt_at timestamptz,lease_until timestamptz,last_error_code text,last_started_at timestamptz,last_succeeded_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(user_id,source_type));
      CREATE TABLE project_expiry_journals(id uuid PRIMARY KEY,user_id uuid,project_id int,entries json,created_at timestamptz,UNIQUE(user_id,project_id));
      CREATE FUNCTION pause_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN OLD; END $$;
      CREATE TRIGGER pause_delete BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION pause_delete()`)
    await pool.query('INSERT INTO users(id) VALUES($1)', [owner])
    await pool.query("INSERT INTO projects VALUES(1,$1,CURRENT_TIMESTAMP-interval '40 days')", [owner])
    await pool.query('INSERT INTO files VALUES(2,$1,1,$2)', [owner, `${owner}/trash/a`])
    await pool.query('INSERT INTO calendar_events VALUES(5,$1,1)', [owner])
    await pool.query('INSERT INTO scheduled_tasks VALUES(6,$1,5)', [owner])
    await mkdir(directory, { recursive: true })
    await writeFile(file, '正文')
    await writeFile(path.join(directory, 'untracked'), '保留')
    const moduleUrl = pathToFileURL(path.resolve('src/modules/projects/lifecycle/expiry.ts')).href
    const program = `import { Pool } from 'pg'; import { purgeExpiredProject } from ${JSON.stringify(moduleUrl)}; const p=new Pool({connectionString:process.env.TEST_URL,options:process.env.TEST_OPTIONS}); await purgeExpiredProject(p,process.env.TEST_ROOT,new Date(),null); await p.end();`
    child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { env: { ...process.env, TEST_URL: url!, TEST_OPTIONS: `-c search_path=${schema}`, TEST_ROOT: root }, stdio: 'ignore' })
    const exited = new Promise<number | null>(resolve => child!.once('exit', resolve))
    let staged = false
    for (let i = 0; i < 100; i++) {
      if ((await readdir(directory)).some(name => name.startsWith('a.gugu-purge-'))) { staged = true; break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(staged, true)
    child.kill('SIGKILL')
    await exited
    child = undefined
    let recoveredAfterCrash = false
    for (let i = 0; i < 100 && !recoveredAfterCrash; i++) {
      recoveredAfterCrash = (await recoverProjectExpiryJournal(pool, root)) === true
      if (!recoveredAfterCrash) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(recoveredAfterCrash, true)
    assert.equal(await readFile(file, 'utf8'), '正文')
    await pool.query('DROP TRIGGER pause_delete ON files')
    const { purgeExpiredProject } = await import('../../src/modules/projects/lifecycle/expiry.js')
    assert.equal(await purgeExpiredProject(pool, root, new Date()), true)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM scheduled_tasks')).rows[0].n, 0)
    assert.deepEqual((await pool.query(`SELECT source_id,pending_source_ids,generation FROM rag_index_jobs WHERE user_id=$1 AND source_type='scheduled_task'`, [owner])).rows[0], { source_id: '6', pending_source_ids: ['6'], generation: 1 })
    await assert.rejects(readFile(file))
    assert.equal(await readFile(path.join(directory, 'untracked'), 'utf8'), '保留')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM project_expiry_journals')).rows[0].n, 0)
    await pool.query("INSERT INTO projects VALUES(3,$1,CURRENT_TIMESTAMP-interval '40 days')", [owner])
    await pool.query('INSERT INTO files VALUES(4,$1,3,$2)', [owner, `${owner}/trash/b`])
    await writeFile(path.join(directory, 'b'), '正文')
    await pool.query('CREATE TRIGGER pause_delete BEFORE DELETE ON files FOR EACH ROW EXECUTE FUNCTION pause_delete()')
    const cleanup = purgeExpiredProject(pool, root, new Date())
    let secondStaged = false
    for (let i = 0; i < 100; i++) {
      if ((await readdir(directory)).some(name => name.startsWith('b.gugu-purge-'))) { secondStaged = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(secondStaged, true)
    const competingRequest = pool.query('SELECT id FROM projects WHERE id=3 FOR UPDATE')
    await Promise.race([
      Promise.all([cleanup, competingRequest]),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('连接池并发清理超时')), 8000).unref() }),
    ])
  } finally {
    child?.kill('SIGKILL')
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
