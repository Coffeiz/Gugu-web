import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify, { type FastifyRequest } from 'fastify'
import type { Transporter } from 'nodemailer'
import { createAuthEmailSender, type SmtpEmailSettings } from '../../src/domains/auth/smtp-email.js'
import { registerRegistrationCodeRoute } from '../../src/domains/auth/routes/auth-registration-code.js'

const emailSettings: SmtpEmailSettings = {
  host: 'smtp.example.test',
  port: 465,
  user: 'mailer@example.test',
  password: 'synthetic-smtp-password',
  fromAddress: 'no-reply@example.test',
  enabled: true,
  useSsl: true,
}

test('registration-code route delivers the reserved code through the system SMTP adapter', async () => {
  const messages: Array<Record<string, unknown>> = []
  const emailSender = createAuthEmailSender(emailSettings, {
    async sendMail(message: Record<string, unknown>) {
      messages.push(message)
      return { accepted: [message.to] }
    },
  } as unknown as Pick<Transporter, 'sendMail'>)
  assert.ok(emailSender)

  const reserved: Array<[string, string]> = []
  const app = Fastify({ logger: false })
  registerRegistrationCodeRoute(app, {
    registrationVerificationEnabled: true,
    systemEmailAvailable: true,
    async rateLimit(_request: FastifyRequest) {},
    async emailIsOccupied() { return false },
    codeStore: {
      createCode() { return '042731' },
      async reserve(email, code) { reserved.push([email, code]); return true },
      async clear() {},
    },
    sendRegistrationVerification(email, code) {
      return emailSender.sendRegistrationVerification({ to: email, code })
    },
  })

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/registration-code',
      payload: { email: ' Person@Example.Test ' },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { ok: true })
    assert.deepEqual(reserved, [['person@example.test', '042731']])
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.to, 'person@example.test')
    assert.equal(messages[0]?.subject, '咕咕 · 注册验证码')
    assert.match(String(messages[0]?.text), /042731/)
    assert.match(String(messages[0]?.html), /042731/)
  } finally {
    await app.close()
  }
})
