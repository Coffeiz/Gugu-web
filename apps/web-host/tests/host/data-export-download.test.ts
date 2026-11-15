import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {createDataExportDownloader,ExportDownloadError} from '../../../../packages/core/src/data-portability/download-export-node.js'
import {writePythonPortableArchive} from '../helpers/portable-archive.js'
const owner='00000000-0000-4000-8000-000000000001',job='00000000-0000-4000-8000-000000000002'

test('下载校验完整密文后按Range输出明文，校验/权限/范围失败不改任务且关闭资源', {skip:!process.env.GUGU_CORE_GOLDEN_PYTHON&&'需要隔离Python'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-export-download-'))
 try{
  const plain=Buffer.from('synthetic archive range payload'),path=join(root,'data.gupa')
  writePythonPortableArchive(path,`data-portability:${owner.replaceAll('-','')}:${job.replaceAll('-','')}`,plain)
  const encrypted=await readFile(path);let abortDuringRead:AbortController|undefined;let closed=0,visible=true,digest=createHash('sha256').update(encrypted).digest('hex')
  const download=createDataExportDownloader(async(sql,params)=>{assert.match(sql,/SELECT/);assert.equal(params[0],owner);return {rows:visible?[{artifact_key:'synthetic.gupa',artifact_size:encrypted.length,artifact_sha256:digest}]:[]}},async()=>({size:encrypted.length,readAt:async(offset,length)=>{abortDuringRead?.abort();return encrypted.subarray(offset,offset+length)},close:async()=>{closed++}}),'synthetic-secret')
  const result=await download(owner,job,'bytes=-7');assert.equal(result.status,206);assert.equal(result.total,plain.length)
  const chunks:Buffer[]=[];for await(const chunk of result.body)chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks),plain.subarray(-7));assert.equal(closed,1)
  await assert.rejects(download(owner,job,'bytes=1000-'),error=>error instanceof ExportDownloadError&&error.code==='invalid_range');assert.equal(closed,2)
  digest='wrong';await assert.rejects(download(owner,job),error=>error instanceof ExportDownloadError&&error.code==='checksum_failed');assert.equal(closed,3)
  visible=false;await assert.rejects(download(owner,job),error=>error instanceof ExportDownloadError&&error.code==='not_found');assert.equal(closed,3)
  visible=true;digest=createHash('sha256').update(encrypted).digest('hex');abortDuringRead=new AbortController()
  await assert.rejects(download(owner,job,undefined,abortDuringRead.signal));assert.equal(closed,4)
 }finally{await rm(root,{recursive:true,force:true})}
})
