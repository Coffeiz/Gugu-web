import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import test from 'node:test'
import {openPortableArchive} from '../../../../packages/core/src/data-portability/archive-reader-node.js'
const python=process.env.GUGU_CORE_GOLDEN_PYTHON

test('跨语言分块归档读取验证context/密钥/布局，并在跨1MiB边界只输出认证明文', {skip:!python&&'需要隔离Python参考运行时'},async()=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),temporary=await mkdtemp(join(tmpdir(),'gugu-archive-reader-'))
 try{
  const path=join(temporary,'synthetic.gupa'),context='data-portability:synthetic-owner:synthetic-job'
  const script="from types import SimpleNamespace; import sys; from app.services.data_portability import crypto_stream as c; c.get_settings=lambda:SimpleNamespace(secret_key='synthetic-secret'); f=open(sys.argv[1],'wb'); w=c.EncryptedArchiveWriter(f,sys.argv[2]); w.write(bytes(i%251 for i in range(2*1024*1024+17))); w.finish(); f.close()"
  const result=spawnSync(python!,['-c',script,path,context],{cwd:root,env:{...process.env,PYTHONPATH:join(root,'backend'),GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(temporary,'not-created.json')},encoding:'utf8'})
  assert.equal(result.status,0,'Python参考归档构造失败')
  const encrypted=await readFile(path),source={size:encrypted.length,readAt:async(offset:number,length:number)=>encrypted.subarray(offset,offset+length)}
  const reader=await openPortableArchive(source,'synthetic-secret',context)
  assert.equal(reader.plaintextSize,2*1024*1024+17)
  const chunks:Buffer[]=[];for await(const chunk of reader.stream(1024*1024-3,12))chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks),Buffer.from(Array.from({length:12},(_,i)=>(1024*1024-3+i)%251)))
  await assert.rejects(openPortableArchive(source,'wrong-secret',context))
  await assert.rejects(openPortableArchive(source,'synthetic-secret','wrong-context'))
  encrypted[124]=encrypted[124]!^1
  const broken=await openPortableArchive(source,'synthetic-secret',context)
  await assert.rejects(async()=>{for await(const _ of broken.stream(0,1)){void _}})
 }finally{await rm(temporary,{recursive:true,force:true})}
})
