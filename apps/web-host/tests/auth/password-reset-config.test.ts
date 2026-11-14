import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'

const environment = {
  GUGU_WEBUI_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
  GUGU_WEBUI_SECRET_KEY: 'synthetic-config-secret',
}

test('SMTP environment settings stay private while enabling password recovery', () => {
  const config = loadConfig({
    ...environment,
    SMTP__HOST: 'smtp.example.test',
    SMTP__PORT: '587',
    SMTP__USER: 'sender@example.test',
    SMTP__PASSWORD: 'synthetic-smtp-password',
    SMTP__FROM_ADDR: '咕咕',
    SMTP__USE_SSL: 'false',
  })
  assert.deepEqual(config.smtp, {
    host: 'smtp.example.test',
    port: 587,
    user: 'sender@example.test',
    password: 'synthetic-smtp-password',
    fromAddress: '咕咕',
    enabled: true,
    useSsl: false,
  })
  assert.equal(config.publicSiteConfig.passwordResetEnabled, true)
  assert.equal(Object.keys(config).includes('smtp'), false)
  assert.equal(Object.keys(config).includes('publicAppUrl'), false)
})

test('SMTP override settings and the public reset origin use a temporary config file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gugu-password-reset-config-'))
  const path = join(directory, 'config.override.json')
  try {
    writeFileSync(path, JSON.stringify({
      smtp: {
        host: 'smtp.override.example.test', port: 465, user: 'override@example.test',
        password: 'synthetic-override-password', from_addr: 'Gugu', enabled: true, use_ssl: true,
      },
      public_app_url: 'https://gugu.example.test',
    }))
    const config = loadConfig(environment, path)
    assert.equal(config.smtp.host, 'smtp.override.example.test')
    assert.equal(config.smtp.port, 465)
    assert.equal(config.smtp.useSsl, true)
    assert.equal(config.publicAppUrl, 'https://gugu.example.test')
    assert.equal(config.publicSiteConfig.passwordResetEnabled, true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('invalid public reset origins are rejected before mail construction', () => {
  assert.throws(() => loadConfig({
    ...environment,
    GUGU_SITE_PUBLIC_URL: 'javascript:alert(1)',
  }), /GUGU_SITE_PUBLIC_URL 配置无效/)
})
