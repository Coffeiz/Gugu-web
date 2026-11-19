import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:tls'
import test from 'node:test'
import type { Transporter } from 'nodemailer'
import { createFeedbackNotifier } from '@gugu/core/feedback'
import { createSmtpTransport } from '../../src/adapters/smtp-email.js'

const certDir = process.env.GUGU_TEST_SMTP_CERT_DIR

test('真实 SMTP TLS 投递反馈到隔离本地收件器', { skip: !certDir && '需要隔离 SMTP 测试证书' }, async () => {
  let received = ''
  const server = createServer({ key: await readFile(`${certDir}/key.pem`), cert: await readFile(`${certDir}/cert.pem`) }, (socket) => {
    socket.setEncoding('utf8')
    socket.write('220 localhost ESMTP\r\n')
    let buffer = '', data = false
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) break
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2)
        if (data) {
          if (line === '.') { data = false; socket.write('250 accepted\r\n') } else received += `${line}\n`
        } else if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 authenticated\r\n')
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n')
        else if (line === 'DATA') { data = true; socket.write('354 continue\r\n') }
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('500 unsupported\r\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const preferences = { read: async () => '{"theme":"dark","palette":"blue"}' }
    const settings = { host: '127.0.0.1', port: address.port, user: 'sender@example.test',
      password: 'synthetic', fromAddress: '', enabled: true, useSsl: true, toAddress: 'support@example.test', feedbackEnabled: true }
    const prepare = createFeedbackNotifier(preferences, settings, createSmtpTransport(settings))
    await (await prepare({ ownerId: 'f015908e-1484-42de-9986-4297f4828462', username: 'Synthetic User', category: 'bug', content: 'Synthetic feedback body' }))()
    assert.match(received, /Synthetic feedback body/)
    assert.match(received, /support@example\.test/)
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})

test('反馈通知从真实 PostgreSQL 偏好读取所属用户的当前配色', {
  skip: !process.env.GUGU_WEBUI_TEST_DATABASE_URL && '需要隔离 PostgreSQL 测试库',
}, async () => {
  const { randomUUID } = await import('node:crypto')
  const { Pool } = await import('pg')
  const { createPostgresRuntime } = await import('@gugu/core/data')
  const { createKyselyPreferenceDocumentStore } = await import('@gugu/core')
  const url = process.env.GUGU_WEBUI_TEST_DATABASE_URL!
  const schema = `gugu_feedback_preferences_${randomUUID().replaceAll('-', '')}`
  const owner = '52e137c3-746b-433d-8f3d-78e90d2abc02'
  const other = 'b176b847-7c98-46d7-bf50-c30bcc804087'
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  let runtime: Awaited<ReturnType<typeof createPostgresRuntime>> | undefined
  try {
    runtime = await createPostgresRuntime({ url, schema })
    const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 })
    try {
      await pool.query('CREATE TABLE user_preferences (user_id uuid PRIMARY KEY, data_json text NOT NULL, updated_at timestamptz NOT NULL)')
      const preferences = createKyselyPreferenceDocumentStore(runtime.db, 'postgres')
      await preferences.write(owner, { theme: 'dark', palette: 'green' })
      await preferences.write(other, { theme: 'dark', palette: 'blue' })
      const messages: Array<{ html: string }> = []
      const transport = { async sendMail(message: { html: string }) { messages.push(message); return {} } }
      const settings = { host: 'smtp.example.test', port: 465, user: 'sender@example.test', password: 'synthetic',
        fromAddress: '', enabled: true, useSsl: true, toAddress: 'support@example.test', feedbackEnabled: true }
      const prepare = createFeedbackNotifier(preferences, settings, transport as unknown as Pick<Transporter, 'sendMail'>)
      await (await prepare({ ownerId: owner, username: '合成用户', category: 'bug', content: '合成反馈' }))()
      assert.equal(messages.length, 1)
      assert.match(messages[0]!.html, /#a9c2b5/)
      assert.doesNotMatch(messages[0]!.html, /#9aaecd/)
    } finally { await pool.end() }
  } finally {
    await runtime?.close()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
