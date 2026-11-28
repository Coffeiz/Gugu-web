import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import { createCredentialPatch } from '../../src/modules/byok/store.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('BYOK patch按owner限制凭据，拒绝跨目的地复用密钥且无副作用', {skip:!databaseUrl&&'需要隔离PostgreSQL'},async()=>{
 const schema=`credential_patch_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1})
 const runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const owner='00000000-0000-4000-8000-000000000081',foreign='00000000-0000-4000-8000-000000000082'
 try{
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY)')
  await pool.query('INSERT INTO users VALUES($1),($2)',[owner,foreign])
  await pool.query(`CREATE TABLE user_provider_credentials(
   id integer PRIMARY KEY,user_id uuid NOT NULL,provider text NOT NULL,api_format text NOT NULL,capability text NOT NULL,
   encrypted_value text NOT NULL,nonce text NOT NULL,encrypted_data_key text NOT NULL,key_version integer NOT NULL,
   base_url text NOT NULL,model text NOT NULL,max_tokens integer,context_tokens integer,thinking text,reasoning_effort text,
   reasoning_persistence text NOT NULL,web_search_enabled boolean NOT NULL,image boolean NOT NULL,video boolean NOT NULL,
   audio boolean NOT NULL,image_detail text NOT NULL,dimensions integer,enabled boolean NOT NULL,last_verified_at timestamptz,
   created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL)`)
  await pool.query(`CREATE TABLE user_provider_bindings(user_id uuid, capability text, credential_id int
    REFERENCES user_provider_credentials(id) ON DELETE CASCADE, PRIMARY KEY(user_id,capability))`)
  await pool.query(`CREATE TABLE provider_reasoning_states(user_id uuid,status text,invalidated_reason text,invalidated_at timestamptz,
   encrypted_payload text,payload_nonce text,encrypted_data_key text,payload_size integer,version integer,updated_at timestamptz)`)
  await pool.query(`INSERT INTO user_provider_credentials(id,user_id,provider,api_format,capability,encrypted_value,nonce,encrypted_data_key,key_version,base_url,model,reasoning_persistence,web_search_enabled,image,video,audio,image_detail,enabled,created_at,updated_at)
   VALUES(1,$1,'openai','openai','llm','cipher','nonce','wrapped',1,'https://api.example.test/v1','m1','off',false,false,false,false,'auto',true,now(),now()),
         (2,$2,'openai','openai','llm','other','nonce','wrapped',1,'https://api.example.test/v1','m1','off',false,false,false,false,'auto',true,now(),now()),
         (3,$1,'openai','openai','llm','sibling','nonce','wrapped',1,'https://api.example.test/v1','m1','off',false,false,false,false,'auto',true,now(),now())`,[owner,foreign])
  const patch=createCredentialPatch(runtime.db,{enabled:()=>true,decrypt:async row=>row.encrypted_value==='cipher'?'secret':'foreign',encrypt:async value=>({ciphertext:`encrypted:${value}`,nonce:'new-nonce',encryptedDataKey:'new-wrapped',keyVersion:2})})
  await assert.rejects(patch(foreign,1,{model:'stolen'}),(error:unknown)=>(error as {code:string}).code==='not_found')
  const sameOrigin=await patch(owner,1,{base_url:'https://api.example.test/v2',model:'m2'})
  assert.equal(sameOrigin.base_url,'https://api.example.test/v2');assert.equal(sameOrigin.model,'m2')
  assert.equal((await pool.query('SELECT encrypted_value FROM user_provider_credentials WHERE id=1')).rows[0].encrypted_value,'cipher')
  await assert.rejects(patch(owner,1,{base_url:'https://attacker.example.test/v1'}),(error:unknown)=>(error as {statusCode:number}).statusCode===422)
  const unchanged=(await pool.query('SELECT base_url,model,encrypted_value FROM user_provider_credentials WHERE id=1')).rows[0]
  assert.deepEqual(unchanged,{base_url:'https://api.example.test/v2',model:'m2',encrypted_value:'cipher'})
  const updated=await patch(owner,1,{base_url:'https://api.example.test/v2',model:'m2',enabled:true,value:'new-secret'})
  assert.equal(updated.base_url,'https://api.example.test/v2');assert.equal(updated.model,'m2')
  assert.equal(updated.has_value,true);assert.equal(JSON.stringify(updated).includes('new-secret'),false)
  assert.equal((await pool.query('SELECT encrypted_value,key_version FROM user_provider_credentials WHERE id=1')).rows[0].encrypted_value,'encrypted:new-secret')
  assert.equal((await pool.query('SELECT enabled FROM user_provider_credentials WHERE id=2')).rows[0].enabled,true)
  assert.equal((await pool.query('SELECT enabled FROM user_provider_credentials WHERE id=3')).rows[0].enabled,false)
  const binding = await pool.query('SELECT credential_id FROM user_provider_bindings WHERE user_id=$1 AND capability=$2',[owner,'llm'])
  assert.equal(binding.rows[0].credential_id,1)
  await patch(owner,1,{enabled:false})
  assert.equal((await pool.query('SELECT credential_id FROM user_provider_bindings WHERE user_id=$1',[owner])).rowCount,0)
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
