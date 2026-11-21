import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLocalFile } from '@gugu/fs/node'
import { CoreError } from '@gugu/core'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import nodemailer from 'nodemailer'
import type { SmtpTestDelivery } from '@gugu/core/email/smtp-test'
import { encryptEncryptedString } from '../../../src/adapters/security/encrypted-string.js'
import { createSmtpTestDelivery } from '../../../src/adapters/email/smtp-test-delivery.js'
import { createPostgresScheduledTaskTestEmailDelivery } from '../../../src/modules/scheduled-tasks/delivery/email.js'
import { createPostgresScheduledTaskResultDelivery } from '../../../src/modules/scheduled-tasks/delivery/results.js'

const owner = 'e2dc7e3a-e0a7-4ce3-a782-3efb560c6d91'
const secret = 'synthetic-smtp-secret'
const globalSmtp = {
  host: 'global.smtp.example.test', port: 465, user: 'global-user', password: 'global-password',
  fromAddress: 'global@example.test', enabled: true, useSsl: true,
}

function pool(row: Record<string, unknown> | undefined) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  return {
    calls,
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values })
      return { rows: row ? [row] : [] }
    },
  }
}

test('邮件测试通知只投递当前 owner 注册邮箱，并优先使用其启用的 SMTP 与外观偏好', async () => {
  const smtpPassword = encryptEncryptedString(secret, 'user-smtp-password')
  const database = pool({
    owner_email: 'owner@example.test', preferences: { theme: 'dark', palette: 'blue' },
    smtp_host: 'user.smtp.example.test', smtp_port: 587, smtp_user: 'user-smtp',
    smtp_password: smtpPassword, smtp_from_addr: '咕咕提醒', smtp_use_ssl: false,
  })
  const deliveries: unknown[] = []
  const deliver = createPostgresScheduledTaskTestEmailDelivery(database as never, {
    secretKey: secret, globalSmtp,
    async send(value) { deliveries.push(value) },
  })
  const result = await deliver({
    ownerId: owner, channels: ['email'], title: '活动提醒（测试）',
    text: '这是一条合成提醒正文。',
  })

  assert.deepEqual(result, { '邮件': '已发送' })
  assert.deepEqual(database.calls.map(call => call.values), [[owner]])
  assert.match(database.calls[0]!.sql, /users/)
  assert.match(database.calls[0]!.sql, /user_smtp_configs/)
  assert.match(database.calls[0]!.sql, /s\.enabled IS TRUE/)
  const sentDelivery = deliveries[0] as {
    host: string; port: number; user: string; password: string; fromName: string
    fromAddress: string; toAddress: string; secure: boolean
    message: { subject: string; plain: string; html: string; images: unknown[] }
  }
  assert.deepEqual({ ...sentDelivery, message: undefined }, {
    host: 'user.smtp.example.test', port: 587, user: 'user-smtp', password: 'user-smtp-password',
    fromName: '咕咕提醒', fromAddress: 'user-smtp', toAddress: 'owner@example.test', secure: false,
    message: undefined,
  })
  const sent = sentDelivery
  assert.equal(sent.message.subject, '咕咕 · 活动提醒（测试）')
  assert.equal(sent.message.plain, '这是一条合成提醒正文。')
  assert.match(sent.message.html, /这是一条合成提醒正文。/)
  assert.equal(sent.message.images.length, 2)
})

test('缺少注册邮箱时不连接 SMTP', async () => {
  const database = pool({ owner_email: '', preferences: {}, smtp_host: null })
  let sent = false
  const deliver = createPostgresScheduledTaskTestEmailDelivery(database as never, {
    secretKey: secret, globalSmtp,
    async send() { sent = true },
  })
  const result = await deliver({ ownerId: owner, channels: ['email'], title: '测试', text: '正文' })
  assert.deepEqual(result, { '邮件': '收件人邮箱不存在' })
  assert.equal(sent, false)
})

test('无启用用户 SMTP 时使用平台 SMTP；发送失败返回脱敏状态', async () => {
  const database = pool({ owner_email: 'owner@example.test', preferences: {}, smtp_host: null })
  const deliveries: unknown[] = []
  const deliver = createPostgresScheduledTaskTestEmailDelivery(database as never, {
    secretKey: secret, globalSmtp,
    async send(value) { deliveries.push(value); throw new Error('credential must not escape') },
  })
  const result = await deliver({ ownerId: owner, channels: ['email'], title: '测试', text: '正文' })
  assert.deepEqual(result, { '邮件': '发送失败（smtp_delivery_error）' })
  assert.equal(deliveries.length, 1)
  assert.equal((deliveries[0] as { host: string }).host, globalSmtp.host)
  assert.equal(JSON.stringify(result).includes('credential must not escape'), false)
})

test('定时结果附带 owner 的库文件与本轮产物，无法读取或超限时整封邮件不发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-scheduled-email-'))
  const row = { id: 1, storage_key: `${owner}/report.txt`, storage_backend: 'local',
    size_bytes: 5, display_name: '子目录/报告', ext: 'txt', mime_type: 'text/plain' }
  const database = { async query(sql: string, values: unknown[]) {
    assert.equal(values[0], owner)
    if (!sql.includes('FROM files')) return { rows: [{ owner_email: 'owner@example.test', smtp_host: null }] }
    return { rows: (values[1] as number[]).includes(1) ? [row] : [] }
  } }
  const sent: SmtpTestDelivery[] = []
  const email = createPostgresScheduledTaskTestEmailDelivery(database as never, {
    secretKey: secret, globalSmtp,
    storageRoot: root,
    async downloadGenerated(ownerId, id) {
      assert.equal(ownerId, owner)
      const source = ['fresh', 'another'].includes(id) ? await openLocalFile(root, `${owner}/image.png`) : null
      if (!source) throw new CoreError('not_found', '合成附件过期')
      return { ...source, fileName: '图片.png', mimeType: 'image/png' }
    },
    async send(value) { sent.push(value) },
  })
  const deliver = createPostgresScheduledTaskResultDelivery(database as never, async () => false, { email })
  const task = { id: '3', ownerId: owner, name: '汇报', payload: '', channels: ['email'],
    deliveryTargets: {}, authorizedTools: [], emailAttachmentFileIds: [1], workspaceId: null, filesystemGrantId: null }
  const result = { text: '执行结果', status: 'success' as const, files: [{ file_id: 1 }, { attach_id: 'fresh' }] }
  try {
    await mkdir(join(root, owner))
    await writeFile(join(root, row.storage_key), 'hello')
    await writeFile(join(root, owner, 'image.png'), 'image')
    assert.deepEqual(await deliver(task, result), { 邮件: '已发送' })
    assert.deepEqual(sent[0]?.attachments?.map(file => [file.filename, file.mimeType, Buffer.from(file.content).toString()]),
      [['报告.txt', 'text/plain', 'hello'], ['图片.png', 'image/png', 'image']])
    assert.deepEqual(await deliver({ ...task, emailAttachmentFileIds: [2] }, result),
      { 邮件: '附件不可用（附件不存在、已删除或不属于当前用户）' })
    assert.deepEqual(await deliver(task, { ...result, files: [{ attach_id: 'expired' }] }),
      { 邮件: '附件不可用（本轮生成的附件已过期，无法添加到邮件）' })
    const file = await open(join(root, row.storage_key), 'r+')
    try { await file.truncate(10 * 1024 * 1024 + 1) } finally { await file.close() }
    assert.deepEqual(await deliver(task, result), { 邮件: '附件不可用（附件单个不能超过 10MB）' })
    for (const path of [row.storage_key, `${owner}/image.png`]) {
      const handle = await open(join(root, path), 'r+')
      try { await handle.truncate(9 * 1024 * 1024) } finally { await handle.close() }
    }
    assert.deepEqual(await deliver(task, { ...result, files: [{ attach_id: 'fresh' }, { attach_id: 'another' }] }),
      { 邮件: '附件不可用（附件总大小不能超过 25MB）' })
    assert.equal(sent.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

const pgUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('SMTP 适配器将定时结果编码为普通 MIME 附件，保留模板内嵌图片', async context => {
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true })
  const encode = stream.sendMail.bind(stream)
  context.mock.method(nodemailer, 'createTransport', () => stream)
  let mime = ''
  context.mock.method(stream, 'sendMail', async (message: Parameters<typeof stream.sendMail>[0]) => {
    const mail = await encode(message)
    mime = mail.message.toString()
    return mail
  })
  await createSmtpTestDelivery({})({
    host: globalSmtp.host, port: globalSmtp.port, user: '', password: '',
    fromName: '咕咕', fromAddress: 'sender@example.test', toAddress: 'owner@example.test', secure: true,
    message: { subject: '报告', plain: '正文', html: '<img src="cid:logo">', images: [
      { cid: 'logo', filename: 'logo.png', base64: 'aW1hZ2U=' },
    ] },
    attachments: [{ filename: 'report.txt', mimeType: 'text/plain', content: Buffer.from('hello') }],
  })
  assert.match(mime, /Content-Disposition: inline; filename=logo\.png/)
  assert.match(mime, /Content-Disposition: attachment; filename=report\.txt/)
  assert.match(mime, /aGVsbG8=/)
})

test('PostgreSQL 定时邮件只读取未删除的 owner 文件', { skip: !pgUrl && '需要隔离 PostgreSQL' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-scheduled-email-pg-'))
  const schema = `test_scheduled_email_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: pgUrl })
  const database = new Pool({ connectionString: pgUrl, options: `-c search_path=${schema}` })
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await database.query(`CREATE TABLE users(id uuid PRIMARY KEY,email text);
      CREATE TABLE user_preferences(user_id uuid,data jsonb);
      CREATE TABLE user_smtp_configs(user_id uuid,enabled boolean,host text,port int,"user" text,password text,from_addr text,use_ssl boolean);
      CREATE TABLE files(id int PRIMARY KEY,user_id uuid,storage_key text,storage_backend text,size_bytes bigint,
        display_name text,ext text,mime_type text,deleted_at timestamptz)`)
    await database.query('INSERT INTO users VALUES ($1,$2)', [owner, 'owner@example.test'])
    const other = randomUUID()
    const key = `${owner}/report.txt`
    const foreignKey = `${other}/report.txt`
    await database.query(`INSERT INTO files VALUES
      (1,$1,$3,'local',5,'报告','txt','text/plain',NULL),
      (2,$2,$4,'local',6,'私密','txt','text/plain',NULL),
      (3,$1,$3,'local',5,'已删除','txt','text/plain',NOW()),
      (4,$1,$4,'local',6,'错误路径','txt','text/plain',NULL)`, [owner, other, key, foreignKey])
    await mkdir(join(root, owner))
    await mkdir(join(root, other))
    await writeFile(join(root, key), 'hello')
    await writeFile(join(root, foreignKey), 'secret')
    const sent: SmtpTestDelivery[] = []
    const email = createPostgresScheduledTaskTestEmailDelivery(database, {
      secretKey: secret, globalSmtp, storageRoot: root,
      async send(message) { sent.push(message) },
    })
    const plan = { ownerId: owner, channels: ['email'], title: '报告', text: '请查收' }
    const deliver = (id: number) => email(plan, { fileIds: [id], generated: [] })
    assert.deepEqual(await deliver(1), { 邮件: '已发送' })
    assert.equal(Buffer.from(sent[0]!.attachments![0]!.content).toString(), 'hello')
    for (const id of [2, 3]) assert.deepEqual(await deliver(id), { 邮件: '附件不可用（附件不存在、已删除或不属于当前用户）' })
    assert.deepEqual(await deliver(4), { 邮件: '附件不可用（附件内容读取失败，文件可能已丢失）' })
    assert.equal(sent.length, 1)
  } finally {
    await database.end()
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) }
    finally {
      await admin.end()
      await rm(root, { recursive: true, force: true })
    }
  }
})
