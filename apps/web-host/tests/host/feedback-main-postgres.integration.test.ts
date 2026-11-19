import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import test from 'node:test'
import { createUserToken } from '../../src/modules/auth/session/token.js'
import { startServer } from '../../src/main.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL
async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test('生产 Host 经认证写入反馈并通过管理员读取 PostgreSQL', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `feedback_main_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped = new URL(databaseUrl!)
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const pool = new Pool({ connectionString: scoped.toString(), max: 2 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-feedback-main-'))
  const overridePath = join(root, 'config.json')
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    await writeFile(overridePath, '{}')
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
      is_active boolean NOT NULL, account_status text, security_version integer, avatar text, created_at timestamptz,
      timezone text, email_subscribed boolean, last_active_at timestamptz);
      CREATE TABLE user_bots(user_id uuid NOT NULL,platform text NOT NULL,enabled boolean NOT NULL);
      CREATE TABLE user_preferences(user_id uuid PRIMARY KEY REFERENCES users(id),data_json text,updated_at timestamptz);
      CREATE TABLE feedbacks(id serial PRIMARY KEY,user_id uuid REFERENCES users(id),username varchar(64) NOT NULL,category varchar(32) NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL)`)
    const owner = randomUUID(), other = randomUUID(), secret = 'synthetic-feedback-main-secret'
    await pool.query(`INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at,email_subscribed)
      VALUES ($1,'synthetic-owner','owner@example.test',true,'active',1,CURRENT_TIMESTAMP,false),
             ($2,'synthetic-other','other@example.test',true,'active',1,CURRENT_TIMESTAMP,false)`, [owner, other])
    host = await startServer({ GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: overridePath, GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(await freePort()),
      GUGU_WEBUI_REDIS_URL: '', ADMIN_USERNAME: 'synthetic-admin', ADMIN_PASSWORD: 'synthetic-password' })
    const headers = (userId: string) => ({ authorization: `Bearer ${createUserToken(userId, 1, secret)}` })
    assert.equal((await host.app.inject({ method: 'POST', url: '/api/v1/feedback', payload: { category: 'bug', content: 'x' } })).statusCode, 401)
    assert.equal((await host.app.inject({ method: 'POST', url: '/api/v1/feedback', headers: headers(owner), payload: { category: 'wrong', content: 'x' } })).statusCode, 400)
    const submit = await host.app.inject({ method: 'POST', url: '/api/v1/feedback', headers: headers(owner), payload: { category: 'bug', content: '\u001c\ufeff合成反馈\ufeff\u001c' } })
    assert.equal(submit.statusCode, 201)
    assert.equal((await host.app.inject({ url: '/api/v1/admin/feedback' })).statusCode, 401)
    const login = await host.app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { username: 'synthetic-admin', password: 'synthetic-password' } })
    assert.equal(login.statusCode, 200)
    const listed = await host.app.inject({ url: '/api/v1/admin/feedback?category=bug', headers: { authorization: `Bearer ${login.json().access_token}` } })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().total, 1)
    assert.equal(listed.json().items[0].content, '\ufeff合成反馈\ufeff')
    const stored = await pool.query('SELECT user_id, content, created_at FROM feedbacks')
    assert.equal(stored.rows[0].user_id, owner)
    assert.equal(stored.rows[0].content, '\ufeff合成反馈\ufeff')
    assert.ok(stored.rows[0].created_at)
  } finally {
    await host?.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})

test('生产 Host 保存反馈后通过真实 SMTP 投递当前用户配色', {
  skip: (!databaseUrl || !process.env.GUGU_TEST_SMTP_CERT_DIR) && '需要隔离 PostgreSQL 与 SMTP 测试证书',
}, async () => {
  const certDir = process.env.GUGU_TEST_SMTP_CERT_DIR!
  let received = ''
  let acceptMail: (() => void) | undefined
  const accepted = new Promise<void>((resolve) => { acceptMail = resolve })
  const smtp = createTlsServer({ key: await readFile(join(certDir, 'key.pem')), cert: await readFile(join(certDir, 'cert.pem')) }, (socket) => {
    socket.setEncoding('utf8'); socket.write('220 localhost ESMTP\r\n')
    let buffer = '', data = false
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) break
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2)
        if (data) {
          if (line === '.') { data = false; socket.write('250 accepted\r\n'); acceptMail?.() }
          else received += `${line}\n`
        } else if (/^EHLO /i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n')
        else if (/^AUTH PLAIN /i.test(line)) socket.write('235 authenticated\r\n')
        else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n')
        else if (line === 'DATA') socket.write('354 continue\r\n'), data = true
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('500 unsupported\r\n')
      }
    })
  })
  await new Promise<void>((resolve, reject) => { smtp.once('error', reject); smtp.listen(0, '127.0.0.1', resolve) })
  const address = smtp.address()
  assert.ok(address && typeof address !== 'string')
  const schema = `feedback_mail_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'gugu-feedback-mail-'))
  let host: Awaited<ReturnType<typeof startServer>> | undefined
  let pool: Pool | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const scoped = new URL(databaseUrl!)
    scoped.searchParams.set('options', `-c search_path=${schema}`)
    pool = new Pool({ connectionString: scoped.toString(), max: 2 })
    await pool.query(`CREATE TABLE users(id uuid PRIMARY KEY, username text NOT NULL, display_name text, email text NOT NULL,
      is_active boolean NOT NULL, account_status text, security_version integer, avatar text, created_at timestamptz,
      timezone text, email_subscribed boolean, last_active_at timestamptz);
      CREATE TABLE user_bots(user_id uuid NOT NULL,platform text NOT NULL,enabled boolean NOT NULL);
      CREATE TABLE user_preferences(user_id uuid PRIMARY KEY REFERENCES users(id),data_json text,updated_at timestamptz);
      CREATE TABLE feedbacks(id serial PRIMARY KEY,user_id uuid REFERENCES users(id),username varchar(64) NOT NULL,category varchar(32) NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL)`)
    const owner = randomUUID(), secret = 'synthetic-feedback-mail-secret'
    await pool.query(`INSERT INTO users(id,username,email,is_active,account_status,security_version,created_at,email_subscribed)
      VALUES ($1,'sample-owner','owner@example.test',true,'active',1,CURRENT_TIMESTAMP,false)`, [owner])
    await pool.query('INSERT INTO user_preferences(user_id,data_json) VALUES ($1,$2)', [owner, JSON.stringify({ palette: 'green' })])
    const overridePath = join(root, 'config.json')
    await writeFile(overridePath, JSON.stringify({ smtp: { enabled: true, host: '127.0.0.1', port: address.port, user: 'sender@example.test',
      password: 'synthetic', from_addr: 'sender@example.test', to_addr: 'support@example.test', use_ssl: true, feedback_email_enabled: true } }))
    host = await startServer({ GUGU_WEBUI_DATABASE_URL: scoped.toString(), GUGU_WEBUI_SECRET_KEY: secret,
      GUGU_CONFIG_OVERRIDE_FILE: overridePath, GUGU_WEBUI_HOST: '127.0.0.1', GUGU_WEBUI_PORT: String(await freePort()), GUGU_WEBUI_REDIS_URL: '' })
    const response = await host.app.inject({ method: 'POST', url: '/api/v1/feedback',
      headers: { authorization: `Bearer ${createUserToken(owner, 1, secret)}` }, payload: { category: 'bug', content: 'Synthetic feedback chain' } })
    assert.equal(response.statusCode, 201)
    const timeout = AbortSignal.timeout(10_000)
    await Promise.race([accepted, new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('反馈邮件未送达')), { once: true }))])
    assert.match(received, /Synthetic feedback chain/)
    assert.match(received, /support@example\.test/)
    assert.match(received, /#718a7e/)
    const stored = await pool.query('SELECT user_id, content FROM feedbacks')
    assert.deepEqual(stored.rows.map((row) => [row.user_id, row.content]), [[owner, 'Synthetic feedback chain']])
  } finally {
    await host?.close(); await pool?.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
    await new Promise<void>((resolve, reject) => smtp.close((error) => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
