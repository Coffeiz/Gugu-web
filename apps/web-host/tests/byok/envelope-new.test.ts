import test from 'node:test'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { createByokEnvelope, createConfiguredByokEnvelope, readConfiguredByokMasterKeys, resolveByokKeyFile } from '../../src/modules/byok/crypto.js'

test('隔离主密钥跨语言加解密、版本轮换和并发首次创建',{skip:!process.env.GUGU_CORE_GOLDEN_PYTHON&&'需要隔离 Python'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-test-'))
 try{
  const path=join(dir,'key'), env={...process.env,CREDENTIALS_MASTER_KEY_FILE:path,CREDENTIALS_MASTER_KEY:'',CREDENTIALS_MASTER_KEY_PREVIOUS:'',CREDENTIALS_MASTER_KEY_VERSION:'1',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(dir,'missing')}
  const codec=createByokEnvelope({keyFile:path,version:1})
  const rows=await Promise.all(Array.from({length:8},()=>createByokEnvelope({keyFile:path,version:1}).encrypt('合成密钥')))
  assert.equal((await (await import('node:fs/promises')).stat(path)).mode&0o777,0o600)
  const python=process.env.GUGU_CORE_GOLDEN_PYTHON
  assert.ok(python)
  const script='import json,sys\nfrom app.byok.crypto import decrypt_envelope,encrypt_envelope\nr=json.load(sys.stdin)\nprint(json.dumps({"values":[decrypt_envelope(x["ciphertext"],x["nonce"],x["encryptedDataKey"],key_version=1) for x in r],"encrypted":encrypt_envelope("跨语言",key_version=1)}))'
  const out=JSON.parse(execFileSync(python,['-c',script],{cwd:'../../backend',env,input:JSON.stringify(rows),encoding:'utf8'}))
  assert.deepEqual(out.values,Array(8).fill('合成密钥'))
  assert.equal(await codec.decrypt({ciphertext:out.encrypted[0],nonce:out.encrypted[1],encryptedDataKey:out.encrypted[2],keyVersion:1}),'跨语言')
  const old=await codec.encrypt('旧版本')
  const rotated=createByokEnvelope({keyFile:join(dir,'new'),version:2,previousKey:(await import('node:fs/promises')).readFile(path,'ascii').then(s=>s.trim())})
  assert.equal(await rotated.decrypt(old),'旧版本')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('显式主密钥与上一版本解析不创建文件，空文件不覆盖',{skip:process.platform!=='linux'&&'需要 Linux 目录句柄'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-config-'))
 try{
  const {writeFile,readFile,stat,chmod}=await import('node:fs/promises'),path=join(dir,'key')
  const old=createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path,CREDENTIALS_MASTER_KEY:'old-synthetic',CREDENTIALS_MASTER_KEY_VERSION:'1'})
  const value=await old.encrypt('synthetic')
  const next=createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path,CREDENTIALS_MASTER_KEY:'new-synthetic',CREDENTIALS_MASTER_KEY_PREVIOUS:'old-synthetic',CREDENTIALS_MASTER_KEY_VERSION:'2'})
  assert.equal(await next.decrypt(value),'synthetic')
  await assert.rejects(stat(path),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT')
  await writeFile(path,'existing-synthetic\n');await chmod(path,0o644)
  await createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path}).encrypt('synthetic')
  assert.equal((await stat(path)).mode&0o777,0o600)
  await writeFile(path,'')
  await assert.rejects(createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path}).encrypt('synthetic'))
  assert.equal(await readFile(path,'utf8'),'')
  assert.throws(()=>createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_VERSION:'invalid'}))
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('模型版本材料只读解析当前与上一密钥，不创建缺失密钥文件',{skip:process.platform!=='linux'&&'需要 Linux 目录句柄'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-version-material-'))
 try{
  const {writeFile,stat}=await import('node:fs/promises'),path=join(dir,'key')
  assert.deepEqual(await readConfiguredByokMasterKeys({CREDENTIALS_MASTER_KEY_FILE:path,CREDENTIALS_MASTER_KEY_VERSION:'2'}),{})
  await assert.rejects(stat(path),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT')
  await writeFile(path,'file-current-synthetic\n',{mode:0o600})
  assert.deepEqual(await readConfiguredByokMasterKeys({CREDENTIALS_MASTER_KEY_FILE:path,CREDENTIALS_MASTER_KEY_VERSION:'3',CREDENTIALS_MASTER_KEY_PREVIOUS:'previous-synthetic'}),{
   '2':'previous-synthetic','3':'file-current-synthetic',
  })
  assert.deepEqual(await readConfiguredByokMasterKeys({CREDENTIALS_MASTER_KEY:'current-synthetic',CREDENTIALS_MASTER_KEY_PREVIOUS:'previous-synthetic',CREDENTIALS_MASTER_KEY_VERSION:'3'}),{
   '2':'previous-synthetic','3':'current-synthetic',
  })
  assert.deepEqual(await readConfiguredByokMasterKeys({BYOK:'{"master_key":"nested-synthetic"}',CREDENTIALS_MASTER_KEY_VERSION:'1'}),{
   '1':'nested-synthetic',
  })
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('持久主密钥文件变更后当前进程读取最新内容',{skip:process.platform!=='linux'&&'需要 Linux 目录句柄'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-refresh-'))
 try{
  const {writeFile}=await import('node:fs/promises'),path=join(dir,'key')
  await writeFile(path,'old-synthetic\n')
  const codec=createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path,CREDENTIALS_MASTER_KEY_VERSION:'1'})
  const old=await codec.encrypt('synthetic')
  await writeFile(path,'new-synthetic\n')
  await assert.rejects(codec.decrypt(old))
  const fresh=await codec.encrypt('fresh')
  assert.equal(await codec.decrypt(fresh),'fresh')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('自定义同步工作区内路径不得创建密钥',async()=>{
 const {resolve}=await import('node:path'),{stat}=await import('node:fs/promises')
 const path=resolve('../../backend/data/synthetic-byok-guard-never')
 await assert.rejects(createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path}).encrypt('synthetic'))
 await assert.rejects(stat(path),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT')
})

test('外部目录别名指向工作区时不得写入主密钥',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-symlink-'))
 try{
  const {symlink,stat}=await import('node:fs/promises'),{resolve}=await import('node:path')
  const alias=join(dir,'alias'),root=resolve('../..'),path=join(alias,'synthetic-byok-guard-never')
  await symlink(root,alias)
  await assert.rejects(createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path}).encrypt('synthetic'))
  await assert.rejects(stat(path),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT')
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('缺少显式主密钥时拒绝凭据操作，环境密钥可以独立使用', async()=>{
 assert.equal(resolveByokKeyFile({}),null)
 assert.equal(resolveByokKeyFile({CREDENTIALS_MASTER_KEY_FILE:' '}),null)
 assert.deepEqual(await readConfiguredByokMasterKeys({}),{})
 const configured=createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY:'synthetic-host-master'})
 const row=await configured.encrypt('synthetic')
 assert.equal(await configured.decrypt(row),'synthetic')
 const unconfigured=createConfiguredByokEnvelope({})
 await assert.rejects(unconfigured.encrypt('synthetic'),/未配置凭据主密钥/)
 await assert.rejects(unconfigured.decrypt(row),/未配置凭据主密钥/)
})

test('多个 Node 调用并发写入时只初始化显式主密钥文件', {skip:process.platform!=='linux'&&'需要 Linux 目录句柄'}, async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-node-init-'))
 try{
  const {stat}=await import('node:fs/promises'),path=join(dir,'key')
  const env={CREDENTIALS_MASTER_KEY_FILE:path}
  assert.deepEqual(await readConfiguredByokMasterKeys(env),{})
  const rows=await Promise.all(Array.from({length:4},()=>createConfiguredByokEnvelope(env).encrypt('synthetic')))
  assert.equal((await stat(path)).mode&0o777,0o600)
  const codec=createConfiguredByokEnvelope(env)
  assert.deepEqual(await Promise.all(rows.map(row=>codec.decrypt(row))),Array(4).fill('synthetic'))
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('密钥文件自身为符号链接时拒绝读取和改权限',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-link-'))
 try{
  const {symlink,writeFile,stat}=await import('node:fs/promises'),target=join(dir,'target'),path=join(dir,'key')
  await writeFile(target,'synthetic\n',{mode:0o644});await symlink(target,path)
  await assert.rejects(createConfiguredByokEnvelope({CREDENTIALS_MASTER_KEY_FILE:path}).encrypt('synthetic'))
  assert.equal((await stat(target)).mode&0o777,0o644)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('主密钥环境优先级与 Python settings 一致', {skip:!process.env.GUGU_CORE_GOLDEN_PYTHON},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-env-'))
 try{
  for(const settings of [
   {CREDENTIALS_MASTER_KEY:'direct-synthetic',BYOK__MASTER_KEY:'nested-synthetic',BYOK:'{"master_key":"json-synthetic"}'},
   {CREDENTIALS_MASTER_KEY:'',BYOK__MASTER_KEY:'nested-synthetic',BYOK:'{"master_key":"json-synthetic"}'},
   {CREDENTIALS_MASTER_KEY:'',BYOK:'{"master_key":"json-synthetic"}'},
  ]){
   const path=join(dir,`key-${Math.random()}`),env={...process.env,CREDENTIALS_MASTER_KEY_PREVIOUS:'',CREDENTIALS_MASTER_KEY_VERSION:'1',GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:join(dir,'missing'),PYTHONPATH:'.',...settings,CREDENTIALS_MASTER_KEY_FILE:path}
   delete (env as Record<string,string|undefined>).BYOK__MASTER_KEY
   if('BYOK__MASTER_KEY' in settings)env.BYOK__MASTER_KEY=settings.BYOK__MASTER_KEY
   const script='import json\nfrom app.byok.crypto import encrypt_envelope\nprint(json.dumps(encrypt_envelope("synthetic",key_version=1)))'
   const value=JSON.parse(execFileSync(process.env.GUGU_CORE_GOLDEN_PYTHON!,['-c',script],{cwd:'../../backend',env,encoding:'utf8'}))
   const codec=createConfiguredByokEnvelope(env)
   assert.equal(await codec.decrypt({ciphertext:value[0],nonce:value[1],encryptedDataKey:value[2],keyVersion:1}),'synthetic')
  }
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('创建时父目录被替换不能写入替换目录',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'byok-race-'))
 try{
  const {mkdir,rename,symlink,stat}=await import('node:fs/promises'),parent=join(dir,'parent'),held=join(dir,'held'),outside=join(dir,'outside')
  await mkdir(parent);await mkdir(outside)
  const codec=createByokEnvelope({keyFile:join(parent,'key'),version:1,validateKeyFile:async(after)=>{if(after){await rename(parent,held);await symlink(outside,parent)}}})
  await codec.encrypt('synthetic').catch(()=>undefined)
  await assert.rejects(stat(join(outside,'key')),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT')
 }finally{await rm(dir,{recursive:true,force:true})}
})
