import { it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Kysely,PostgresDialect,sql } from 'kysely'
import pg from 'pg'
import { tablesSql,type Database } from '../../../src/data/schema.js'
import { noteLifecycleContract } from '../../fixtures/note-lifecycle-contract.js'
const url=process.env.GUGU_CORE_TEST_POSTGRES_URL
if(!url)throw new Error('PG生命周期合同需要显式隔离数据库')
it('PG恢复普通笔记、独立/借用事务和Undo失败原子回滚',async()=>{
 const admin=new pg.Pool({connectionString:url,max:1}),schema='gugu_note_lifecycle_'+randomUUID().replaceAll('-','')
 await admin.query('CREATE SCHEMA "'+schema+'"')
 const db=new Kysely<Database>({dialect:new PostgresDialect({pool:new pg.Pool({connectionString:url,options:'-c search_path='+schema,max:2})})})
 try{const ddl=tablesSql('postgres');await sql.raw(ddl.mindNodes).execute(db);await sql.raw(ddl.undo).execute(db);await noteLifecycleContract(db,'postgres')}
 finally{await db.destroy();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end()}
})
