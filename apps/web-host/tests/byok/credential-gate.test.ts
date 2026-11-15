import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createByokGateReader} from '../../src/modules/byok/gate.js'

test('BYOK gate默认、环境JSON、嵌套环境和override优先级及热更新保持Python行为',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gugu-byok-gate-')),path=join(root,'config.json')
 try{
  await writeFile(path,'{}')
  assert.equal(createByokGateReader(path,{})(),true)
  assert.equal(createByokGateReader(path,{BYOK:'{"enabled":false}'})(),false)
  assert.equal(createByokGateReader(path,{BYOK:'{"enabled":false}',BYOK__ENABLED:'true'})(),true)
  assert.equal(createByokGateReader(path,{BYOK__ENABLED:'false',AI:'{"deployment_mode":"local"}'})(),true)
  assert.equal(createByokGateReader(path,{BYOK__ENABLED:'false',AI:'{"deployment_mode":"local"}',AI__DEPLOYMENT_MODE:'cloud'})(),false)
  assert.throws(createByokGateReader(path,{BYOK:'{"enabled":null}'}))
  assert.throws(createByokGateReader(path,{AI:'{"deployment_mode":null}'}))
  assert.equal(createByokGateReader(path,{BYOK__ENABLED:'false',AI__DEPLOYMENT_MODE:'LOCAL'})(),false)
  const read=createByokGateReader(path,{BYOK__ENABLED:'true',AI__DEPLOYMENT_MODE:'local'})
  await writeFile(path,JSON.stringify({byok:{enabled:false},ai:{deployment_mode:'cloud'}}))
  assert.equal(read(),false)
  await writeFile(path,JSON.stringify({byok:{enabled:false},ai:{deployment_mode:'local'}}))
  assert.equal(read(),true)
  await writeFile(path,JSON.stringify({byok:{enabled:true},ai:{deployment_mode:'cloud'}}))
  assert.equal(read(),true)
  await writeFile(path,'{')
  assert.throws(read)
 }finally{await rm(root,{recursive:true,force:true})}
})
