import { Pool } from 'pg'
import { applyRagIndexMigration,checkRagIndexMigration,queueNodeRagCutoverBaseline } from './rag-index-migrate.js'

async function main(){
 const command=process.argv[2]
 const connectionString=process.env.GUGU_WEBUI_DATABASE_URL?.trim()
 if(!['check','apply','queue-baseline'].includes(command??'')||process.argv.length!==3||!connectionString||!/^postgres(?:ql)?:\/\//i.test(connectionString))throw new Error('迁移命令或数据库配置无效')
 const pool=new Pool({connectionString,max:1})
 try{
  if(command==='queue-baseline'){
   const result=await queueNodeRagCutoverBaseline(pool)
   process.stdout.write(JSON.stringify(result)+'\n')
   return
  }
  const result=command==='check'?await checkRagIndexMigration(pool):await applyRagIndexMigration(pool)
  process.stdout.write(`${result}\n`)
  if(result==='pending')process.exitCode=2
 }finally{await pool.end()}
}
main().catch(()=>{process.stderr.write('RAG 索引迁移失败\n');process.exitCode=1})
