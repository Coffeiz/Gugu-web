import assert from 'node:assert/strict'
import test from 'node:test'
import { checkDatabaseReadiness } from '../../src/database.js'

test('database readiness verifies the tables and columns required by Node auth and business reads', async () => {
  const statements: string[] = []
  await checkDatabaseReadiness(async (statement) => {
    statements.push(statement)
    return { rows: [] }
  })

  assert.equal(statements.length, 21)
  assert.match(statements[0], /SELECT 1/)
  assert.match(statements[1], /FROM users LIMIT 0/)
  assert.match(statements[1], /account_status/)
  assert.match(statements[1], /hashed_password/)
  assert.match(statements[2], /FROM user_bots LIMIT 0/)
  assert.match(statements[3], /FROM agent_usage LIMIT 0/)
  assert.match(statements[3], /is_byok/)
  assert.match(statements[4], /FROM files LIMIT 0/)
  assert.match(statements[5], /FROM storage_quota_ledgers LIMIT 0/)
  assert.match(statements[6], /FROM projects LIMIT 0/)
  assert.match(statements[7], /FROM project_file_counts LIMIT 0/)
  assert.match(statements[8], /FROM calendar_events LIMIT 0/)
  assert.match(statements[8], /end_time/)
  assert.match(statements[8], /idempotency_fingerprint/)
  assert.match(statements[9], /FROM clients LIMIT 0/)
  assert.match(statements[10], /FROM site_notifications LIMIT 0/)
  assert.match(statements[11], /FROM notification_reads LIMIT 0/)
  assert.match(statements[12], /FROM notification_dismissals LIMIT 0/)
  assert.match(statements[13], /FROM frontend_events LIMIT 0/)
  assert.match(statements[14], /FROM scheduled_tasks LIMIT 0/)
  assert.match(statements[15], /FROM undo_operations LIMIT 0/)
  assert.match(statements[16], /FROM workspaces LIMIT 0/)
  assert.match(statements[17], /FROM workspace_directories LIMIT 0/)
  assert.match(statements[18], /FROM folders LIMIT 0/)
  assert.match(statements[19], /FROM audit_logs LIMIT 0/)
  assert.match(statements[20], /FROM storage_category_snapshots LIMIT 0/)
})

test('database readiness fails closed when the expected application schema is missing', async () => {
  let queryCount = 0
  await assert.rejects(
    checkDatabaseReadiness(async (statement) => {
      queryCount += 1
      if (statement.includes('FROM users')) throw new Error('synthetic missing users table')
      return { rows: [] }
    }),
    /synthetic missing users table/,
  )
  assert.equal(queryCount, 2)
})
