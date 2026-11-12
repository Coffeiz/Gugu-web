import assert from 'node:assert/strict'
import test from 'node:test'
import { checkDatabaseReadiness } from '../src/database.js'

test('database readiness verifies the tables and columns required by Node auth and business reads', async () => {
  const statements: string[] = []
  await checkDatabaseReadiness(async (statement) => {
    statements.push(statement)
    return { rows: [] }
  })

  assert.equal(statements.length, 11)
  assert.match(statements[0], /SELECT 1/)
  assert.match(statements[1], /FROM users LIMIT 0/)
  assert.match(statements[1], /account_status/)
  assert.match(statements[2], /FROM user_bots LIMIT 0/)
  assert.match(statements[3], /FROM projects LIMIT 0/)
  assert.match(statements[4], /FROM project_file_counts LIMIT 0/)
  assert.match(statements[5], /FROM calendar_events LIMIT 0/)
  assert.match(statements[5], /end_time/)
  assert.match(statements[6], /FROM clients LIMIT 0/)
  assert.match(statements[7], /FROM site_notifications LIMIT 0/)
  assert.match(statements[8], /FROM notification_reads LIMIT 0/)
  assert.match(statements[9], /FROM notification_dismissals LIMIT 0/)
  assert.match(statements[10], /FROM frontend_events LIMIT 0/)
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
