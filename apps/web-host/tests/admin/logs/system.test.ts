import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { createSystemLogReader } from '../../../src/modules/admin/logs.js'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('管理员系统日志按级别大小写过滤、时间倒序并保留空traceback', { skip: !url && '需要隔离PG' }, async () => {
  const schema = `system_logs_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  try {
    await pool.query('CREATE TABLE system_logs(id serial PRIMARY KEY,level varchar(20) NOT NULL,module varchar(200) NOT NULL,message text NOT NULL,traceback text,created_at timestamptz NOT NULL)')
    await pool.query(`INSERT INTO system_logs(level,module,message,created_at) VALUES
      ('ERROR','synthetic','合成错误','2026-01-01T00:00:00.123456Z'),
      ('INFO','synthetic','合成状态','2026-01-02T00:00:00Z')`)
    const reader = createSystemLogReader((text, params) => pool.query(text, params))
    assert.deepEqual((await reader.list(200, null)).items.map(r => r.level), ['INFO', 'ERROR'])
    assert.deepEqual(await reader.list(1, 'error'), { items: [{ id: 1, level: 'ERROR', module: 'synthetic', message: '合成错误', traceback: null, created_at: '2026-01-01T00:00:00.123456+00:00' }] })
    assert.deepEqual(await reader.list(0, ''), { items: [] })
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
