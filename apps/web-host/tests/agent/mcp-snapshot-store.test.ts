import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {createPostgresRuntime} from '@gugu/core/data'
import {createMcpSnapshotStore} from '../../../../packages/core/src/mcp/snapshot-store.js'
const url=process.env.GUGU_WEBUI_TEST_DATABASE_URL
const owner='00000000-0000-4000-8000-000000000061',other='00000000-0000-4000-8000-000000000062'
test('MCP声明快照按owner持久化并拒绝过期配置写入',{skip:!url&&'需要隔离 PostgreSQL'},async()=>{
 const schema=`gugu_mcp_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});await admin.query(`CREATE SCHEMA "${schema}"`)
 const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}),runtime=await createPostgresRuntime({url:url!,schema})
 try{
  await pool.query('CREATE TABLE user_mcp_tool_schema_snapshots(user_id uuid PRIMARY KEY,config_digest text NOT NULL,schemas json NOT NULL,refreshed_at timestamptz NOT NULL)')
  let current='v1';const store=createMcpSnapshotStore(runtime.db,'postgres',async()=>current)
  const tool={name:'mcp_demo_read',description_short:'读取',description:'完整描述',input_schema:{type:'object'},server_id:'00000000-0000-4000-8000-000000000063',server_name:'demo',tool_name:'read'}
  await store.writeIfCurrent(owner,'v1',[tool]);assert.deepEqual((await store.read(owner))?.tools,[tool]);assert.equal(await store.read(other),null)
  current='v2';await store.writeIfCurrent(owner,'v1',[]);assert.equal((await store.read(owner))?.digest,'v1')
 }finally{await runtime.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end()}
})
