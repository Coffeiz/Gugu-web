import assert from 'node:assert/strict'
import test from 'node:test'
import type { Transporter } from 'nodemailer'
import { createFeedbackNotifier, type FeedbackNotificationSettings } from '@gugu/core/feedback'

const ownerId = 'a2419f7e-6ab5-4e98-a7af-0394039f4507'
const settings: FeedbackNotificationSettings & import('../../src/domains/auth/smtp-email.js').SmtpEmailSettings = {
  enabled: true, host: 'smtp.example.test', port: 465, user: 'sender@example.test', password: 'synthetic',
  fromAddress: '', useSsl: true, toAddress: 'support@example.test', feedbackEnabled: true,
}
const notice = { ownerId, username: '合成用户', category: 'bug', content: '<script>合成反馈</script>' }
function preferences(data: string | null, reads: string[]) {
  return { async read(owner: string) { reads.push(owner); return data } }
}
function transport(messages: unknown[]): Pick<Transporter, 'sendMail'> {
  return { sendMail: async (message: unknown) => { messages.push(message); return {} } } as unknown as Pick<Transporter, 'sendMail'>
}

test('反馈通知先读取提交用户偏好，再按配置发送带转义正文的邮件', async () => {
  const reads: string[] = [], messages: unknown[] = []
  const prepare = createFeedbackNotifier(preferences('{"theme":"dark","palette":"blue"}', reads), settings, transport(messages))
  const send = await prepare(notice)
  assert.deepEqual(reads, [ownerId]); assert.equal(messages.length, 0)
  await send()
  assert.equal(messages.length, 1)
  const message = messages[0] as { to: string; subject: string; text: string; html: string }
  assert.equal(message.to, 'support@example.test')
  assert.equal(message.subject, '[咕咕反馈] Bug 反馈 · 合成用户')
  assert.match(message.text, /<script>合成反馈<\/script>/)
  assert.match(message.html, /&lt;script&gt;合成反馈&lt;\/script&gt;/)
  assert.match(message.html, /#9aaecd/)
})

test('反馈通知关闭或未配置收件人时不发送，损坏偏好使用默认样式', async () => {
  for (const override of [{ feedbackEnabled: false }, { toAddress: '' }]) {
    const messages: unknown[] = []
    await (await createFeedbackNotifier(preferences('invalid', []), { ...settings, ...override }, transport(messages))(notice))()
    assert.deepEqual(messages, [])
  }
  const messages: unknown[] = []
  await (await createFeedbackNotifier(preferences('invalid', []), settings, transport(messages))(notice))()
  assert.match((messages[0] as { html: string }).html, /#565b64/)
})

test('未知配色不会阻止反馈邮件发送，邮件使用中性色', async () => {
  for (const palette of ['constructor', '__proto__', 'toString']) {
    const messages: unknown[] = []
    await (await createFeedbackNotifier(preferences(JSON.stringify({ palette }), []), settings, transport(messages))(notice))()
    assert.equal(messages.length, 1)
    assert.match((messages[0] as { html: string }).html, /#565b64/)
  }
})

test('反馈邮件使用当前用户配色', async () => {
  for (const [palette, color] of Object.entries({ neutral: '#565b64', cafe: '#715653', red: '#a66e73', blue: '#65789a', green: '#718a7e' })) {
    const messages: unknown[] = []
    await (await createFeedbackNotifier(preferences(JSON.stringify({ palette }), []), settings, transport(messages))(notice))()
    assert.ok((messages[0] as { html: string }).html.includes(color))
  }
})

test('偏好读取与邮件投递失败明确传给调用方处理', async () => {
  const failedPreferences = { read: async () => { throw new Error('synthetic read failure') } }
  await assert.rejects(createFeedbackNotifier(failedPreferences, settings, transport([]))(notice))
  const failedTransport = { sendMail: async () => { throw new Error('synthetic smtp failure') } } as unknown as Pick<Transporter, 'sendMail'>
  await assert.rejects((await createFeedbackNotifier(preferences(null, []), settings, failedTransport)(notice))())
})

test('通知正文与已保存正文遵循同一 Python 空白规则，读取失败不撤销写入', async () => {
  const { createFeedbackSubmission } = await import('@gugu/core/feedback')
  const { createFeedbackService } = await import('@gugu/core/feedback')
  let saved = '', notified = '', sent = false
  const core = createFeedbackService({ async submit(_owner, _username, _category, content) { saved = content }, async list() { return { total: 0, items: [] } } })
  const feedback = createFeedbackSubmission(core, async (input) => { notified = input.content; return async () => { sent = true } }, (work) => { void work() })
  await feedback.submit(ownerId, '合成用户', 'bug', '\u001c\ufeff内容\ufeff\u001c')
  assert.equal(saved, '\ufeff内容\ufeff')
  assert.equal(notified, saved)
  assert.equal(sent, true)
  const broken = createFeedbackSubmission(core, async () => { throw new Error('synthetic read failure') }, (work) => { void work() })
  await assert.rejects(broken.submit(ownerId, '合成用户', 'bug', '已保存'))
  assert.equal(saved, '已保存')
})
