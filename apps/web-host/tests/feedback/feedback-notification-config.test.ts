import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../../src/config.js'

const required = { GUGU_WEBUI_DATABASE_URL: 'postgresql://localhost/example', GUGU_WEBUI_SECRET_KEY: 'synthetic-secret' }
test('反馈通知配置按系统开关和收件人加载，覆盖文件优先', async () => {
  const defaults = loadConfig(required)
  assert.equal(defaults.smtp.feedbackEnabled, true)
  assert.equal(defaults.smtp.toAddress, '')
  const configured = loadConfig({ ...required, SMTP__FEEDBACK_EMAIL_ENABLED: 'false', SMTP__TO_ADDR: 'support@example.test' })
  assert.equal(configured.smtp.feedbackEnabled, false)
  assert.equal(configured.smtp.toAddress, 'support@example.test')
  const root = await mkdtemp(join(tmpdir(), 'gugu-feedback-config-'))
  try {
    const path = join(root, 'config.json')
    await writeFile(path, JSON.stringify({ smtp: { feedback_email_enabled: true, to_addr: 'other@example.test' } }))
    const overridden = loadConfig({ ...required, SMTP__FEEDBACK_EMAIL_ENABLED: 'false', SMTP__TO_ADDR: 'support@example.test' }, path)
    assert.equal(overridden.smtp.feedbackEnabled, true)
    assert.equal(overridden.smtp.toAddress, 'other@example.test')
  } finally { await rm(root, { recursive: true, force: true }) }
})
