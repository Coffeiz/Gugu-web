import assert from 'node:assert/strict'
import test from 'node:test'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,readFile,rm,rmdir,writeFile,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {createPostgresDataExportDeleter} from '../../src/modules/data-portability/delete-export-postgres.js'

const databaseUrl=process.env.GUGU_WEBUI_TEST_DATABASE_URL

test('隔离 PostgreSQL 与 Local 存储：删除仅清理 owner 的已结束归档，拒绝活动、越权和符号链接路径',{skip:!databaseUrl&&'set GUGU_WEBUI_TEST_DATABASE_URL to run isolated PostgreSQL integration'},async()=>{
  const schema=`export_delete_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:databaseUrl!,max:1})
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool=new Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`,max:2}),root=await mkdtemp(join(tmpdir(),'export-delete-'))
  const owner='00000000-0000-4000-8000-000000000071',other='00000000-0000-4000-8000-000000000072'
  const ready='10000000-0000-4000-8000-000000000001',active='10000000-0000-4000-8000-000000000002',foreign='10000000-0000-4000-8000-000000000003',unsafe='10000000-0000-4000-8000-000000000004'
  const directory='10000000-0000-4000-8000-000000000005'
  let outside:string|undefined
  try{
    await pool.query('CREATE TABLE data_export_jobs(id uuid PRIMARY KEY,user_id uuid NOT NULL,status text NOT NULL,artifact_key text)')
    const ownerHex=owner.replaceAll('-',''),otherHex=other.replaceAll('-','')
    const key=(job:string)=>`${ownerHex}/.data-portability/exports/${job.replaceAll('-','')}.gupa`
    const foreignKey=`${otherHex}/.data-portability/exports/${foreign.replaceAll('-','')}.gupa`
    for(const [id,user,status,artifact] of [[ready,owner,'ready',key(ready)],[active,owner,'running',key(active)],
      [foreign,other,'ready',foreignKey],[unsafe,owner,'ready',key(unsafe)],[directory,owner,'ready',key(directory)]] as const)
      await pool.query('INSERT INTO data_export_jobs(id,user_id,status,artifact_key) VALUES($1,$2,$3,$4)',[id,user,status,artifact])
    const readyFile=join(root,key(ready)),foreignFile=join(root,foreignKey)
    outside=await mkdtemp(join(tmpdir(),'export-delete-outside-'))
    await mkdir(join(root,ownerHex,'.data-portability','exports'),{recursive:true});await writeFile(readyFile,'synthetic archive')
    await mkdir(join(root,otherHex,'.data-portability','exports'),{recursive:true});await writeFile(foreignFile,'other owner archive')
    await mkdir(join(outside,'exports'));await writeFile(join(outside,'exports',`${unsafe.replaceAll('-','')}.gupa`),'outside archive')

    const remove=createPostgresDataExportDeleter(pool,root)
    assert.equal(await readFile(readyFile,'utf8'),'synthetic archive')
    await remove(owner,ready)
    await assert.rejects(readFile(readyFile),{code:'ENOENT'})
    await assert.rejects(remove(owner,active),error=>(error as {code?:string}).code==='conflict')
    await assert.rejects(remove(owner,foreign),error=>(error as {code?:string}).code==='not_found')
    const directoryPath=join(root,key(directory))
    await mkdir(directoryPath)
    await writeFile(join(directoryPath,'keep.txt'),'保留目录里的文件')
    await assert.rejects(remove(owner,directory),error=>(error as {code?:string}).code==='storage_error')
    assert.equal(await readFile(join(directoryPath,'keep.txt'),'utf8'),'保留目录里的文件')
    await rm(directoryPath,{recursive:true})
    const exportDirectory=join(root,ownerHex,'.data-portability','exports')
    await rmdir(exportDirectory)
    await symlink(join(outside,'exports'),exportDirectory)
    await assert.rejects(remove(owner,unsafe),error=>(error as {code?:string}).code==='storage_error')
    assert.equal(await readFile(foreignFile,'utf8'),'other owner archive')
    assert.equal(await readFile(join(outside,'exports',`${unsafe.replaceAll('-','')}.gupa`),'utf8'),'outside archive')
    assert.deepEqual((await pool.query('SELECT id::text FROM data_export_jobs ORDER BY id')).rows.map(row=>row.id),[active,foreign,unsafe,directory].sort())
  }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();await rm(root,{recursive:true,force:true});if(outside)await rm(outside,{recursive:true,force:true})}
})
