import { Pool } from 'pg'
import { applyRagIndexMigration,checkRagIndexMigration } from './rag-index-migrate.js'

async function main(){
 const command=process.argv[2]
 if(!['check','apply'].includes(command??'')||process.argv.length!==3||!process.env.GUGU_WEBUI_DATABASE_URL)throw new Error('迁移命令或数据库配置无效')
 const pool=new Pool({connectionString:process.env.GUGU_WEBUI_DATABASE_URL.trim().replace(/^postgresql\+asyncpg:/i,'postgresql:'),max:1})
 try{
  const result=command==='check'?await checkRagIndexMigration(pool):await applyRagIndexMigration(pool)
  process.stdout.write(`${result}\n`)
  if(result==='pending')process.exitCode=2
 }finally{await pool.end()}
}
main().catch(()=>{process.stderr.write('RAG 索引迁移失败\n');process.exitCode=1})
