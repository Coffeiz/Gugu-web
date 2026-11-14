import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../src/config.js'

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
    staticRoot: fileURLToPath(new URL('../../../frontend/dist', import.meta.url)),
  })
  assert.equal(config.databaseUrl, 'postgres://synthetic:synthetic-only@db.invalid/gugu_test')
  assert.equal(config.storageDefaultLimitBytes, null)
  assert.equal(config.adminUsername, 'admin')
  assert.equal(config.adminPassword, '')
  assert.equal(config.adminAllowedHosts, '')
  assert.equal(config.accessTokenExpiresMinutes, 10080)
  assert.equal(config.storageLocalPath, resolve('../Gugu-data/users'))
  assert.equal(config.filesyncEnabled, true)
  assert.deepEqual(config.workspaceRuntimeSettings, {
    shellEnabled: true,
    shellSystemEnabled: false,
    shellDangerousEnabled: true,
    automaticModeEnabled: true,
    fullUserSandboxAuthorizationEnabled: true,
    terminalMode: 'auto',
  })
  assert.equal(JSON.stringify(config).includes('synthetic-only'), false)
  assert.equal(JSON.stringify(config).includes('Gugu-data/users'), false)
})

test('loadConfig keeps Admin credentials, host policy, and storage location private', () => {
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    ADMIN_USERNAME: 'ops-admin',
    ADMIN_PASSWORD: 'synthetic-admin-password',
    ADMIN_ALLOWED_HOSTS: 'admin.example.test',
    GUGU_LOG_FILE: '/tmp/synthetic-gugu/logs/gugu.log',
    ACCESS_TOKEN_EXPIRE_MINUTES: '720',
    STORAGE__LOCAL_PATH: '/srv/gugu/users',
  })
  assert.equal(config.adminUsername, 'ops-admin')
  assert.equal(config.adminPassword, 'synthetic-admin-password')
  assert.equal(config.adminAllowedHosts, 'admin.example.test')
  assert.equal(config.accessTokenExpiresMinutes, 720)
  assert.equal(config.storageLocalPath, resolve('/srv/gugu/users'))
  assert.equal(config.logFile, resolve('/tmp/synthetic-gugu/logs/gugu.log'))
  assert.equal(Object.keys(config).includes('logFile'), false)
  for (const value of ['synthetic-admin-password', 'admin.example.test', '/srv/gugu/users'])
    assert.equal(JSON.stringify(config).includes(value), false)
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    ACCESS_TOKEN_EXPIRE_MINUTES: '0',
  }), /ACCESS_TOKEN_EXPIRE_MINUTES/)
})

test('loadConfig reads workspace runtime capabilities with strict Python-aligned settings', () => {
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    AGENT__SHELL_ENABLED: 'false',
    AGENT__SHELL_SYSTEM_ENABLED: 'true',
    AGENT__SHELL_DANGEROUS_ENABLED: 'false',
    AGENT__AUTOMATIC_MODE_ENABLED: 'false',
    SANDBOX__FULL_USER_SANDBOX_AUTHORIZATION_ENABLED: 'false',
    SANDBOX__TERMINAL_MODE: 'pty_disabled',
  })
  assert.deepEqual(config.workspaceRuntimeSettings, {
    shellEnabled: false,
    shellSystemEnabled: true,
    shellDangerousEnabled: false,
    automaticModeEnabled: false,
    fullUserSandboxAuthorizationEnabled: false,
    terminalMode: 'pty_disabled',
  })
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    SANDBOX__TERMINAL_MODE: 'unknown',
  }), /SANDBOX__TERMINAL_MODE/)
})

test('loadConfig keeps the Python-default file sync side effects enabled unless explicitly disabled', () => {
  assert.equal(loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
  }).filesyncEnabled, true)
  assert.equal(loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    FILESYNC__ENABLED: 'false',
  }).filesyncEnabled, false)
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    FILESYNC__ENABLED: 'maybe',
  }), /FILESYNC__ENABLED/)
})

test('loadConfig refuses a legacy OSS backend setting until its data has been migrated', () => {
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    STORAGE__BACKEND: 'oss',
  }), /旧 OSS 数据需先完成迁移或导出/)
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    STORAGE__BACKEND: 'remote',
  }), /只支持本地文件系统/)
})

test('loadConfig reads the optional default storage quota without exposing it', () => {
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    QUOTA__DEFAULT_STORAGE_LIMIT_BYTES: '0',
  })

  assert.equal(config.storageDefaultLimitBytes, 0)
  assert.equal(Object.keys(config).includes('storageDefaultLimitBytes'), false)
  assert.equal(loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    QUOTA__DEFAULT_STORAGE_LIMIT_BYTES: '-1',
  }).storageDefaultLimitBytes, -1)
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    QUOTA__DEFAULT_STORAGE_LIMIT_BYTES: '-2',
  }), /QUOTA__DEFAULT_STORAGE_LIMIT_BYTES/)
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

test('loadConfig keeps the optional Redis URL private and rejects unsupported protocols', () => {
  const config = loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    GUGU_WEBUI_REDIS_URL: 'rediss://synthetic-user:synthetic-password@redis.invalid:6380/2',
  })
  assert.equal(config.redisUrl, 'rediss://synthetic-user:synthetic-password@redis.invalid:6380/2')
  assert.equal(JSON.stringify(config).includes('synthetic-password'), false)
  assert.throws(() => loadConfig({
    GUGU_WEBUI_DATABASE_URL: 'postgres://db.invalid/gugu',
    SECRET_KEY: 'synthetic-secret',
    GUGU_WEBUI_REDIS_URL: 'http://synthetic-user:synthetic-password@redis.invalid',
  }), (error: unknown) => {
    assert.equal(error instanceof Error, true)
    assert.match((error as Error).message, /Redis/)
    assert.equal((error as Error).message.includes('synthetic-password'), false)
    return true
  })
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
