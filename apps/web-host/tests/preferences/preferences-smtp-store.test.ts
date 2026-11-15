import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { createKyselyPreferenceDocumentStore } from '@gugu/core'
import { createPostgresRuntime } from '@gugu/core/data'
import { createKyselySmtpStore, createUserSmtpSettings } from '@gugu/core/smtp'
import { createPostgresPreferencesStore } from '../../src/domains/preferences/persistence/postgres.js'
import { encryptEncryptedString as encryptSmtpPassword } from '../../src/adapters/encrypted-string.js'

const databaseUrl = process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('启用 SMTP 密码能力时缺少 Core 设置服务会明确失败', () => {
  const documentStore = { async read() { return null }, async write() {} }
  assert.throws(() => createPostgresPreferencesStore({} as Pool, { secretKey: 'synthetic', documentStore }), /SMTP 设置服务未配置/)
})

test('SMTP 设置经 Core 加密保存、保留省略的密码并限制用户读取', {
  skip: !databaseUrl && '需要隔离 PostgreSQL',
}, async () => {
  const schema = `smtp_store_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` })
  const core = await createPostgresRuntime({ url: databaseUrl!, schema })
  const secret = 'synthetic-smtp-store-secret'
  try {
    await pool.query(`CREATE TABLE user_smtp_configs(id serial PRIMARY KEY,user_id uuid NOT NULL UNIQUE,
      host text NOT NULL,port integer NOT NULL,"user" text NOT NULL,password text NOT NULL,from_addr text NOT NULL,
      use_ssl boolean NOT NULL,enabled boolean NOT NULL,updated_at timestamptz NOT NULL)`)
    const store = createPostgresPreferencesStore(pool, {
      secretKey: secret, documentStore: createKyselyPreferenceDocumentStore(core.db, 'postgres'),
      smtpSettings: createUserSmtpSettings(createKyselySmtpStore(core.db, 'postgres'), password => encryptSmtpPassword(secret, password)),
    })
    assert.ok(store.smtp)
    const owner = randomUUID(), other = randomUUID()
    const settings = { host: 'smtp.example.test', port: 587, user: 'mailer@example.test', fromAddr: 'no-reply@example.test', useSsl: false, enabled: true }
    await store.smtp.write(owner, settings, 'synthetic-smtp-password')
    const first = await pool.query('SELECT password FROM user_smtp_configs WHERE user_id=$1', [owner])
    assert.match(first.rows[0].password, /^gcm1:/)
    assert.notEqual(first.rows[0].password, 'synthetic-smtp-password')
    await store.smtp.write(owner, { ...settings, host: 'changed.example.test' }, null)
    const second = await pool.query('SELECT password FROM user_smtp_configs WHERE user_id=$1', [owner])
    assert.equal(second.rows[0].password, first.rows[0].password)
    assert.equal((await store.smtp.read(owner))?.host, 'changed.example.test')
    assert.equal(await store.smtp.readPassword(owner), 'synthetic-smtp-password')
    assert.equal(await store.smtp.read(other), null)
    assert.equal(await store.smtp.readPassword(other), '')
    await store.smtp.write(owner, settings, '')
    assert.equal(await store.smtp.readPassword(owner), '')
  } finally {
    await core.close(); await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end()
  }
})
