import { it } from 'vitest'
import SQLite from 'better-sqlite3'
import { Kysely,SqliteDialect } from 'kysely'
import { tablesSql,type Database } from '../../src/data/schema.js'
import { noteLifecycleContract } from '../fixtures/note-lifecycle-contract.js'
it('SQLite恢复普通笔记、独立/借用事务和Undo失败原子回滚',async()=>{
 const file=new SQLite(':memory:'),ddl=tablesSql('sqlite');file.exec(ddl.mindNodes+';'+ddl.undo)
 const db=new Kysely<Database>({dialect:new SqliteDialect({database:file})})
 try{await noteLifecycleContract(db,'sqlite')}finally{await db.destroy()}
})
