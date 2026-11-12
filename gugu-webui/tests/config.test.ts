import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'

test('loadConfig supplies stable local defaults and keeps the database URL private', () => {
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://synthetic:synthetic-only@db.invalid/gugu_test',
    SECRET_KEY: 'synthetic-secret',
  })

  assert.deepEqual(config, {
    appName: 'Gugu',
    host: '127.0.0.1',
    port: 9595,
    postgresPoolMax: 10,
  })
  assert.equal(config.databaseUrl, 'postgres://synthetic:synthetic-only@db.invalid/gugu_test')
  assert.equal(JSON.stringify(config).includes('synthetic-only'), false)
})

test('loadConfig accepts the current SQLAlchemy PostgreSQL URL form for Node pg', () => {
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL:
      'postgresql+asyncpg://synthetic%40user:synthetic%2Fpass@db.invalid/gugu_test',
    SECRET_KEY: 'synthetic-secret',
  })

  assert.equal(config.databaseUrl, 'postgresql://synthetic%40user:synthetic%2Fpass@db.invalid/gugu_test')
  assert.equal(JSON.stringify(config).includes('synthetic'), false)
})

test('loadConfig refuses a missing database URL without revealing configuration values', () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) => {
      assert.equal(error instanceof Error, true)
      assert.match((error as Error).message, /GUGU_WEBUI_DATABASE_URL/)
      return true
    },
  )
})

test('loadConfig requires a signing secret and keeps it private', () => {
  assert.throws(
    () => loadConfig({ GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu' }),
    /GUGU_WEBUI_SECRET_KEY 或 SECRET_KEY/,
  )
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    GUGU_WEBUI_SECRET_KEY: 'synthetic-auth-secret',
  })
  assert.equal(config.secretKey, 'synthetic-auth-secret')
  assert.equal(JSON.stringify(config).includes('synthetic-auth-secret'), false)
})

test('loadConfig rejects malformed and non-PostgreSQL URLs without echoing credentials', () => {
  for (const databaseUrl of [
    'not-a-url',
    'mysql://synthetic:synthetic-only@db.invalid/gugu_test',
  ]) {
    assert.throws(() => loadConfig({ GUGU_WEBUI_DATABASE_URL: databaseUrl, SECRET_KEY: 'synthetic-secret' }), (error: unknown) => {
      assert.equal(error instanceof Error, true)
      assert.match((error as Error).message, /PostgreSQL/)
      assert.equal((error as Error).message.includes('synthetic-only'), false)
      return true
    })
  }
})

test('loadConfig validates the HTTP port and pool size', () => {
  assert.throws(
    () => loadConfig({ GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu', SECRET_KEY: 'synthetic-secret', GUGU_WEBUI_PORT: '70000' }),
    /端口无效/,
  )
  assert.throws(
    () => loadConfig({ GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu', SECRET_KEY: 'synthetic-secret', GUGU_WEBUI_PG_POOL_MAX: '0' }),
    /连接池参数无效/,
  )
})
