import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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
    publicSiteConfig: {
      icpNumber: '',
      icpUrl: 'https://beian.miit.gov.cn/',
      passwordResetEnabled: false,
      registrationVerificationEnabled: false,
    },
    staticRoot: fileURLToPath(new URL('../../frontend/dist', import.meta.url)),
  })
  assert.equal(config.databaseUrl, 'postgres://synthetic:synthetic-only@db.invalid/gugu_test')
  assert.equal(JSON.stringify(config).includes('synthetic-only'), false)
})

test('loadConfig reflects public email capabilities without exposing SMTP secrets', () => {
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://synthetic:synthetic-only@db.invalid/gugu_test',
    SECRET_KEY: 'synthetic-secret',
    GUGU_SITE_ICP_NUMBER: '  京ICP备00000000号  ',
    GUGU_SITE_ICP_URL: '   ',
    SMTP__HOST: ' smtp.example.test ',
    SMTP__USER: 'mailer@example.test',
    SMTP__PASSWORD: 'secret-smtp-password',
    SMTP__REGISTRATION_VERIFICATION_ENABLED: 'true',
  })

  assert.deepEqual(config.publicSiteConfig, {
    icpNumber: '京ICP备00000000号',
    icpUrl: 'https://beian.miit.gov.cn/',
    passwordResetEnabled: true,
    registrationVerificationEnabled: true,
  })
  assert.equal(JSON.stringify(config).includes('secret-smtp-password'), false)
  assert.equal(JSON.stringify(config).includes('mailer@example.test'), false)
})

test('loadConfig disables registration verification when SMTP is unavailable or its switch is off', () => {
  const missingSmtp = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    SMTP__REGISTRATION_VERIFICATION_ENABLED: 'true',
  })
  const incompleteSmtp = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    SMTP__HOST: 'smtp.example.test',
    SMTP__USER: 'mailer@example.test',
    SMTP__PASSWORD: 'synthetic-password',
    SMTP__FROM_ADDR: 'invalid@',
  })
  const disabledRegistration = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    SMTP__HOST: 'smtp.example.test',
    SMTP__USER: 'mailer@example.test',
    SMTP__PASSWORD: 'synthetic-password',
    SMTP__ENABLED: 'false',
    SMTP__REGISTRATION_VERIFICATION_ENABLED: 'false',
  })
  const verificationOff = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    SMTP__HOST: 'smtp.example.test',
    SMTP__USER: 'mailer@example.test',
    SMTP__PASSWORD: 'synthetic-password',
    SMTP__REGISTRATION_VERIFICATION_ENABLED: 'false',
  })

  assert.equal(missingSmtp.publicSiteConfig.passwordResetEnabled, false)
  assert.equal(missingSmtp.publicSiteConfig.registrationVerificationEnabled, false)
  assert.equal(incompleteSmtp.publicSiteConfig.passwordResetEnabled, false)
  assert.equal(disabledRegistration.publicSiteConfig.passwordResetEnabled, false)
  assert.equal(disabledRegistration.publicSiteConfig.registrationVerificationEnabled, false)
  assert.equal(verificationOff.publicSiteConfig.passwordResetEnabled, true)
  assert.equal(verificationOff.publicSiteConfig.registrationVerificationEnabled, false)
})

test('loadConfig rejects malformed public email feature switches', () => {
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    SMTP__ENABLED: 'sometimes',
  }), /SMTP__ENABLED 配置无效/)
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

  const staticDirectory = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    GUGU_WEBUI_STATIC_DIR: './web-dist',
  })
  assert.equal(staticDirectory.staticRoot, resolve('./web-dist'))
})
