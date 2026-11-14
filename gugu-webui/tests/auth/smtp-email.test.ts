import assert from 'node:assert/strict'
import nodemailer, { type Transporter } from 'nodemailer'
import test from 'node:test'
import {
  createAuthEmailSender,
  createSmtpTransport,
  sendUserSmtpTestEmail,
  type SmtpEmailSettings,
} from '../../src/domains/auth/smtp-email.js'

const settings: SmtpEmailSettings = {
  host: 'smtp.example.test',
  port: 587,
  user: 'sender@example.test',
  password: 'synthetic-smtp-password',
  fromAddress: '咕咕',
  enabled: true,
  useSsl: false,
}

test('SMTP transport requires STARTTLS or implicit TLS according to the configured mode', () => {
  let captured: Record<string, unknown> | undefined
  const transport = nodemailer.createTransport({ streamTransport: true })
  const createTransport = ((options: Record<string, unknown>) => {
    captured = options
    return transport
  }) as typeof nodemailer.createTransport

  assert.equal(createSmtpTransport(settings, createTransport), transport)
  assert.equal(captured?.secure, false)
  assert.equal(captured?.requireTLS, true)
  assert.deepEqual(captured?.auth, { user: 'sender@example.test', pass: 'synthetic-smtp-password' })
  assert.equal(createSmtpTransport({ ...settings, useSsl: true }, createTransport), transport)
  assert.equal(captured?.secure, true)
  assert.equal(captured?.requireTLS, false)
  assert.equal(createSmtpTransport({ ...settings, enabled: false }, createTransport), null)
})

test('auth emails include the reset link and verification code with safe HTML text', async () => {
  const messages: Array<Record<string, unknown>> = []
  const transport = {
    async sendMail(message: Record<string, unknown>) {
      messages.push(message)
      return { accepted: [message.to] }
    },
  }
  const sender = createAuthEmailSender(settings, transport as unknown as Pick<Transporter, 'sendMail'>)
  assert.ok(sender)
  assert.equal(await sender.sendResetEmail({
    to: 'user@example.test', username: '<script>用户</script>', link: 'https://gugu.example.test/reset-password?token=synthetic',
  }), true)
  assert.match(String(messages[0]?.text), /https:\/\/gugu\.example\.test\/reset-password\?token=synthetic/)
  assert.match(String(messages[0]?.html), /&lt;script&gt;用户&lt;\/script&gt;/)
  assert.doesNotMatch(String(messages[0]?.html), /<script>/)

  assert.equal(await sender.sendRegistrationVerification({ to: 'user@example.test', code: '123456' }), true)
  assert.match(String(messages[1]?.text), /123456/)
  assert.equal(await sender.sendRegistrationVerification({ to: 'user@example.test', code: '12345' }), false)
  assert.equal(await sender.sendResetEmail({
    to: 'user@example.test', username: 'synthetic', link: 'javascript:alert(1)',
  }), false)
})

test('email-change verification escapes content and notices never expose a token or replacement address', async () => {
  const messages: Array<Record<string, unknown>> = []
  const transport = {
    async sendMail(message: Record<string, unknown>) {
      messages.push(message)
      return { accepted: [message.to] }
    },
  }
  const sender = createAuthEmailSender(settings, transport as unknown as Pick<Transporter, 'sendMail'>)
  assert.ok(sender)
  assert.equal(await sender.sendEmailChangeVerification({
    to: 'fresh@example.test',
    username: '<img src=x>',
    link: 'https://gugu.example.test/verify-email-change?token=synthetic-token',
  }), true)
  assert.match(String(messages[0]?.html), /&lt;img src=x&gt;/)
  assert.match(String(messages[0]?.html), /verify-email-change\?token=synthetic-token/)

  assert.equal(await sender.sendEmailChangeNotice({
    to: 'cedarz@example.test', username: '<script>用户</script>', kind: 'requested',
  }), true)
  assert.equal(await sender.sendEmailChangeNotice({
    to: 'fresh@example.test', username: '小北', kind: 'completed',
  }), true)
  for (const message of messages.slice(1)) {
    assert.doesNotMatch(String(message.text), /fresh@example\.test|synthetic-token/)
    assert.doesNotMatch(String(message.html), /fresh@example\.test|synthetic-token|<script>/)
  }
})

test('user SMTP test sends to the requested recipient using the supplied connection settings', async () => {
  let capturedSettings: SmtpEmailSettings | undefined
  let capturedMessage: Record<string, unknown> | undefined
  await sendUserSmtpTestEmail({
    host: 'smtp.example.test', port: 465, user: 'mailer@example.test', password: 'synthetic-smtp-password',
    fromAddr: 'no-reply@example.test', toAddr: 'recipient@example.test', useSsl: true,
    template: '<script>', theme: 'dark', palette: 'blue',
  }, (settings) => {
    capturedSettings = settings
    return {
      async sendMail(message: Record<string, unknown>) {
        capturedMessage = message
        return { accepted: [message.to] }
      },
    } as unknown as Pick<Transporter, 'sendMail'>
  })
  assert.equal(capturedSettings?.host, 'smtp.example.test')
  assert.equal(capturedSettings?.port, 465)
  assert.equal(capturedSettings?.useSsl, true)
  assert.equal(capturedSettings?.password, 'synthetic-smtp-password')
  assert.equal(capturedMessage?.to, 'recipient@example.test')
  assert.equal(capturedMessage?.subject, '咕咕 · 邮件样式测试')
  assert.match(String(capturedMessage?.text), /SMTP 配置和邮件模板均可用/)
  assert.match(String(capturedMessage?.html), /&lt;script&gt;/)
  assert.doesNotMatch(String(capturedMessage?.html), /<script>/)
})
