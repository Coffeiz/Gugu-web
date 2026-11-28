import { agentPromptDefaults } from '@gugu/core/agent/context/prompts'
import { byokBindings } from '@gugu/database/postgres/migrations/0021_byok_bindings'
import { imInboundQueue } from '@gugu/database/postgres/migrations/0046_im_inbound_queue'
import { agentReasoningSql } from '@gugu/database/postgres/migrations/0012_agent_reasoning'
import { imGatewaySql } from '@gugu/database/postgres/migrations/0013_im_gateway'
import { imReflectionSql } from '@gugu/database/postgres/migrations/0014_im_reflection'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createPostgresRuntime,tablesSql} from '@gugu/core/data'
import {encryptEncryptedString} from '../../../src/adapters/security/encrypted-string.js'

const run=promisify(execFile)
const pythonSchema=String.raw`
import json,io,importlib.util
from sqlalchemy.schema import CreateTable,AddConstraint,CreateIndex
from sqlalchemy.dialects.postgresql import dialect
from sqlalchemy import JSON
from app.models import Base
from alembic.migration import MigrationContext
from alembic.operations import Operations
d=dialect(); tables=list(Base.metadata.tables.values()); ddl=[]; metadata={}
for table in tables:
    ddl.append(str(CreateTable(table,include_foreign_key_constraints=[]).compile(dialect=d)))
    defaults={}; json_columns=[]
    for column in table.columns:
        if isinstance(column.type,JSON): json_columns.append(column.name)
        if column.default is not None:
            if column.default.is_scalar: defaults[column.name]=column.default.arg
            elif column.default.is_callable: defaults[column.name]=column.default.arg(None)
    metadata[table.name]={'defaults':defaults,'json':json_columns,'columns':[c.name for c in table.columns]}
for table in tables:
    for constraint in table.foreign_key_constraints: ddl.append(str(AddConstraint(constraint).compile(dialect=d)))
    for index in table.indexes: ddl.append(str(CreateIndex(index).compile(dialect=d)))
buffer=io.StringIO(); context=MigrationContext.configure(dialect=d,opts={'as_sql':True,'output_buffer':buffer})
for migration in ['20261115000004_add_agent_run_startups.py','20261115000006_add_agent_interaction_resumes.py']:
    spec=importlib.util.spec_from_file_location('fixture_migration','alembic/versions/'+migration)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    with Operations.context(context): module.upgrade()
ddl.append(buffer.getvalue())
print(json.dumps({'ddl':ddl,'metadata':metadata},default=str))
`

/** 仅测试：离线ORM编译真实PG列/约束，随机schema与临时文件；绝不对用户库执行DDL。 */
export async function createImProductionFixture(options:{python:string;databaseUrl?:string;platform?:'telegram'|'qq'|'feishu'|'wechat'}){
 const databaseUrl=options.databaseUrl??process.env.GUGU_IM_GATEWAY_TEST_DATABASE_URL
 if(!databaseUrl||!options.python)throw Error('生产fixture需要显式隔离PG与Python解释器')
 const {Pool}=await import('pg'),root=await mkdtemp(join(tmpdir(),'gugu-im-production-')),schema=`im_production_${randomUUID().replaceAll('-','')}`
 const backend=fileURLToPath(new URL('../../../../../backend/',import.meta.url)),compat=fileURLToPath(new URL('../../../../../compat/core-python/src/',import.meta.url))
 const admin=new Pool({connectionString:databaseUrl}),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8}),deliveryPool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:4})
 const storageRoot=join(root,'storage'),promptRoot=join(root,'prompts'),configPath=join(root,'config.fixture.json'),ownerId=randomUUID(),otherOwnerId=randomUUID(),secretKey=randomUUID()
 let core:Awaited<ReturnType<typeof createPostgresRuntime>>|undefined,closed=false
 const close=async()=>{if(closed)return;closed=true;await core?.close();await pool.end();await deliveryPool.end();await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true})}
 try{
  await Promise.all([mkdir(storageRoot,{recursive:true}),mkdir(promptRoot,{recursive:true})])
  for(const name of ['default.md','persona.md','skills.md','policy.md'])await writeFile(join(promptRoot,name),`# 合成测试规范\n你是合成测试助手。仅处理当前授权用户与当前会话的任务。\n`)
  await mkdir(join(promptRoot,'im'),{recursive:true})
  const packagedPrompts=agentPromptDefaults
  for(const name of ['compress_conv.md','im/group_chat.md','im/group_compress.md','memory_compress.md'])await writeFile(join(promptRoot,name),await readFile(join(packagedPrompts,name)))
  for(const name of ['profile_compact.md','pattern_compact.md'])await writeFile(join(promptRoot,name),await readFile(join(backend,'agent','prompts',name)))
  const compiled=await run(options.python,['-c',pythonSchema],{cwd:backend,env:{PATH:process.env.PATH,TZ:'UTC',PYTHONIOENCODING:'utf-8',PYTHONPATH:[backend,compat].join(delimiter),PYTHONDONTWRITEBYTECODE:'1',GUGU_ENV_FILE:join(root,'missing.env'),GUGU_CONFIG_OVERRIDE_FILE:join(root,'missing.json')},maxBuffer:8*1024*1024})
  const source=JSON.parse(compiled.stdout) as {ddl:string[];metadata:Record<string,{defaults:Record<string,unknown>;json:string[];columns:string[]}>}
  await admin.query(`CREATE SCHEMA "${schema}"`)
  for(const statement of source.ddl)await pool.query(statement)
  const coreSchema=tablesSql('postgres')
  for(const statement of Object.values(coreSchema)){
   if(typeof statement!=='string')continue
   const name=/CREATE TABLE(?: IF NOT EXISTS)? ([a-z_]+)/u.exec(statement)?.[1]
   if(name&&!(await pool.query('SELECT to_regclass($1) AS name',[name])).rows[0]?.name)await pool.query(statement)
  }
  for(const statement of Object.values(imGatewaySql))await pool.query(statement)
  for(const statement of Object.values(imReflectionSql))await pool.query(statement)
  await pool.query(agentReasoningSql.agentReasoningActive)
  await byokBindings.apply(pool)
  await imInboundQueue.apply(pool)
  core=await createPostgresRuntime({url:databaseUrl,schema,maxConnections:6})
  async function insert(table:string,overrides:Record<string,unknown>){
   const meta=source.metadata[table]
   if(!meta||!/^[a-z_]+$/u.test(table)||Object.keys(overrides).some(k=>!meta.columns.includes(k)))throw Error('合成fixture表或字段无效')
   const values={...structuredClone(meta.defaults),...overrides},keys=Object.keys(values)
   return (await pool.query(`INSERT INTO "${table}"(${keys.map(k=>`"${k}"`).join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,keys.map(k=>meta.json.includes(k)?JSON.stringify(values[k]):values[k]))).rows[0]!
  }
  await insert('users',{id:ownerId,username:'moon_synthetic',email:'moon_synthetic@example.test',hashed_password:'synthetic-password-hash',is_active:true,account_status:'active',timezone:'UTC'})
  await insert('users',{id:otherOwnerId,username:'other_synthetic',email:'other_synthetic@example.test',hashed_password:'synthetic-password-hash',is_active:true,account_status:'active',timezone:'UTC'})
  const platform=options.platform??'telegram'
  const bot=await insert('user_bots',{user_id:ownerId,platform,name:'合成咕咕',app_id:platform==='feishu'?'cli_synthetic':'synthetic-app',app_secret:encryptEncryptedString(secretKey,platform==='telegram'?'123456789:synthetic_token_for_gateway_fixture':'synthetic-platform-token'),enabled:true,owner_platform_user_id:platform==='telegram'?'202':'synthetic-owner',group_chat_enabled:true,group_requires_at:false,group_attention_mode:'autonomous'})
  const document={agent:{memory_enabled:true},im:{telegram:true,qq:true,feishu:true,wechat:true},ai:{provider:'openai',model:'synthetic-model',api_key:'synthetic-provider-key',base_url:'https://provider.example.test/v1',api_format:'openai',context_window:32000},byok:{enabled:false}}
  await writeFile(configPath,JSON.stringify(document))
  const environment:NodeJS.ProcessEnv={SECRET_KEY:secretKey,LOCAL_DEPLOYMENT:'true',BYOK__ENABLED:'false',AI:JSON.stringify(document.ai),QUOTA__DEFAULT_TOKEN_LIMIT_6H:''}
  return {pool,deliveryPool,core,root,schema,storageRoot,promptRoot,configPath,configOverridePath:configPath,environment,ownerId,otherOwnerId,botId:String(bot.id),secretKey,platform,insert,close}
 }catch(error){await close();throw error}
}
