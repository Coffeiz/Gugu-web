import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createPostgresRuntime, tablesSql } from '@gugu/core/data'
import { createKyselyScheduledFireReceipts } from '@gugu/core/tasks/schedule-storage'

const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL
test('同一触发时间并发领取只允许一个执行者且其他 owner 不能完成', { skip: !url }, async () => {
  const admin = new Pool({ connectionString: url })
  const schema = `gugu_fire_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const runtime = await createPostgresRuntime({ url: url!, schema })
  try {
    await pool.query(tablesSql('postgres').scheduledFires)
    const receipts = createKyselyScheduledFireReceipts(runtime.db, 'postgres')
    const fire = { taskId: '1', fireAt: 1_800_000_000_000 }
    const results = await Promise.all([receipts.claim(fire, 'a'), receipts.claim(fire, 'b')])
    assert.equal(results.filter(Boolean).length, 1)
    const winner = results[0] ? 'a' : 'b'
    await assert.rejects(receipts.finish(fire, winner === 'a' ? 'b' : 'a', 'completed'))
    await receipts.finish(fire, winner, 'unknown')
    assert.equal(await receipts.claim(fire, 'later'), false)
  } finally {
    await runtime.close()
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
