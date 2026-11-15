import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import pg from 'pg'
import { expect, it } from 'vitest'
import { createByokListService, createPostgresByokListReader } from '../../../src/agent/config/byok.js'
const url = process.env.GUGU_CORE_TEST_POSTGRES_URL
if (!url) throw new Error('必须提供隔离 PG 测试地址')
it('PG BYOK 列表仅属于当前 owner，校验合成信封且不泄露密文', async () => {
  const schema = `gugu_byok_list_${randomUUID().replaceAll('-', '')}`, owner = randomUUID(), other = randomUUID()
  const admin = new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new pg.Pool({connectionString:url, options:`-c search_path=${schema}`})
  try {
    await pool.query(`CREATE TABLE user_provider_credentials(id int PRIMARY KEY,user_id uuid,provider text,api_format text,capability text,base_url text,model text,
      max_tokens int,dimensions int,context_tokens int,thinking text,reasoning_effort text,reasoning_persistence text,web_search_enabled bool,image bool,video bool,audio bool,image_detail text,enabled bool,
      last_verified_at timestamptz,created_at timestamptz,updated_at timestamptz,encrypted_value text,nonce text,encrypted_data_key text,key_version int)`)
    const key = randomBytes(32), nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,nonce)
    const ciphertext = Buffer.concat([cipher.update('synthetic-only-secret'),cipher.final(),cipher.getAuthTag()]).toString('base64')
    await pool.query(`INSERT INTO user_provider_credentials VALUES
      (2,$1,'local','openai','embedding','','m',NULL,1024,NULL,NULL,NULL,'off',false,false,false,false,'auto',false,NULL,'2026-01-01 00:00:00.123456Z','2026-01-01Z',$3,$4,'synthetic-wrap',1),
      (1,$1,'other','openai','llm','','m',NULL,NULL,NULL,NULL,NULL,'off',false,false,false,false,'auto',true,NULL,'2026-01-01Z','2026-01-01Z',NULL,'','',1),
      (3,$2,'foreign','openai','llm','','m',NULL,NULL,NULL,NULL,NULL,'off',false,false,false,false,'auto',true,NULL,'2026-01-01Z','2026-01-01Z','bad','bad','bad',1)`,[owner,other,ciphertext,nonce.toString('base64')])
    const list = createByokListService({enabled:()=>true,readOwned:createPostgresByokListReader(pool),verifyEnvelope: envelope => {
      const bytes = Buffer.from(envelope.encrypted_value,'base64'), decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.nonce,'base64'))
      decipher.setAuthTag(bytes.subarray(-16)); decipher.update(bytes.subarray(0,-16)); decipher.final()
    }})
    const output = await list(owner)
    expect(output.status).toBe('ready'); expect(output.items.map(row=>row.id)).toEqual([1,2]); expect(output.items[1]).toMatchObject({dimensions:1024,enabled:false,has_value:true,created_at:'2026-01-01T00:00:00.123456+00:00'})
    expect(JSON.stringify(output)).not.toContain(ciphertext); expect(JSON.stringify(output)).not.toContain('synthetic-wrap')
    expect((await list(other)).status).toBe('needs_reconfigure')
    expect((await list(randomUUID())).status).toBe('ready')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
