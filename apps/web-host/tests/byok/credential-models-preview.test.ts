import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import { createCredentialModelsPreview } from '../../src/modules/byok/checks/models.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('BYOK models preview只向同目的地复用owner凭据，拒绝越权和跨目的地密钥', {skip:!databaseUrl&&'需要隔离PostgreSQL'},async()=>{
 const schema=`credential_models_${randomUUID().replaceAll('-','')}`
 const admin=new Pool({connectionString:databaseUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:1})
 const runtime=await createPostgresRuntime({url:databaseUrl!,schema})
 const owner='00000000-0000-4000-8000-000000000091',foreign='00000000-0000-4000-8000-000000000092'
 try{
  await pool.query('CREATE TABLE user_provider_credentials(id integer PRIMARY KEY,user_id uuid,provider text,api_format text,capability text,encrypted_value text,nonce text,encrypted_data_key text,key_version integer,base_url text,model text)')
  await pool.query(`INSERT INTO user_provider_credentials VALUES(1,$1,'local','openai','llm','cipher','nonce','wrapped',1,'http://127.0.0.1:43127/v1','m1'),(2,$2,'local','openai','llm','foreign-cipher','nonce','wrapped',1,'http://127.0.0.1:43127/v1','m1')`,[owner,foreign])
  const fetched:Array<{provider:string;baseUrl:string;apiKey:string;model:string}>=[]
  const preview=createCredentialModelsPreview(runtime.db,{enabled:()=>true,decrypt:async row=>row.encrypted_value==='cipher'?'saved-secret':'foreign-secret',fetchModels:async input=>{fetched.push(input);return ['model-z','model-a','model-a']}})
  const same=await preview(owner,{provider:'local',api_format:'openai',base_url:'http://127.0.0.1:43127/v1/',model:'m2',api_key:'',credential_id:1})
  assert.deepEqual(same,{models:['model-z','model-a','model-a']})
  assert.equal(fetched[0].apiKey,'saved-secret')
  await assert.rejects(preview(owner,{provider:'local',api_format:'openai',base_url:'http://127.0.0.1:43128/v1',model:'m1',api_key:'',credential_id:1}),(error:unknown)=>(error as {statusCode:number}).statusCode===422)
  await assert.rejects(preview(owner,{provider:'local',api_format:'openai',base_url:'http://127.0.0.1:43127/v1',model:'m1',api_key:'',credential_id:2}),(error:unknown)=>(error as {code:string}).code==='not_found')
  assert.equal(fetched.length,1)
  const explicit=await preview(owner,{provider:'local',api_format:'openai',base_url:'http://127.0.0.1:43128/v1',model:'m3',api_key:'new-secret',credential_id:1})
  assert.deepEqual(explicit,{models:['model-z','model-a','model-a']});assert.equal(fetched[1].apiKey,'new-secret')
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
