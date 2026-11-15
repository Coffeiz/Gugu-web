import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createImPlatformSettingsReader} from '../../src/modules/im/platform-settings.js'
test('IM开关按默认、环境与override优先并在每次读取反映热更新',async()=>{
 const root=await mkdtemp(join(tmpdir(),'im-platforms-')),path=join(root,'override.json')
 try{
  const read=createImPlatformSettingsReader({IM:'{"qq":false}',IM__FEISHU:'0'},path)
  assert.deepEqual(read(),['wechat','telegram'])
  await writeFile(path,JSON.stringify({im:{qq:'YES',telegram:false}}));assert.deepEqual(read(),['qq','wechat'])
  await writeFile(path,JSON.stringify({im:null}));assert.deepEqual(read(),['wechat','telegram'])
  await writeFile(path,JSON.stringify({im:{qq:null}}));assert.deepEqual(read(),['wechat','telegram'])
  await writeFile(path,JSON.stringify({im:{wechat:false}}));assert.deepEqual(read(),['telegram'])
  assert.throws(()=>createImPlatformSettingsReader({IM__QQ:''},path)())
 }finally{await rm(root,{recursive:true,force:true})}
})
