import type { ByokCredential } from './store.js'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ByokEnvelope {ciphertext:string;nonce:string;encryptedDataKey:string;keyVersion:number}

export interface ByokEnvelopeOptions {keyFile:string|null;version:number;masterKey?:string;previousKey?:string|Promise<string>;validateKeyFile?:(afterMkdir:boolean)=>Promise<void>}

const info='gugu-byok-envelope-v1'

const keyLoads=new Map<string,Promise<string>>()

async function readExisting(path:string):Promise<string>{const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const raw=(await file.readFile('ascii')).trim();if(!raw)throw new Error('凭据主密钥文件为空');await file.chmod(0o600);return raw}finally{await file.close()}}

function key(raw:string):Buffer {
 if(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)){const b=Buffer.from(raw,'base64');if(b.length===32)return b}
 if(/^[0-9a-f]{64}$/i.test(raw))return Buffer.from(raw,'hex')
 return createHash('sha256').update(raw).digest()
}

function encrypt(key:Buffer,nonce:Buffer,plain:Buffer,aad:string):Buffer{const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(aad));return Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()])}

function decrypt(key:Buffer,nonce:Buffer,value:Buffer,aad:string):Buffer{if(value.length<16)throw new Error('凭据信封无效');const cipher=createDecipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(aad));cipher.setAuthTag(value.subarray(-16));return Buffer.concat([cipher.update(value.subarray(0,-16)),cipher.final()])}

/** 密钥文件只能由部署环境显式提供。 */
export function resolveByokKeyFile(env:NodeJS.ProcessEnv):string|null{
 const path=env.CREDENTIALS_MASTER_KEY_FILE?.trim()
 return path?resolve(path):null
}

/**
 * 只读解析模型版本材料所需的密钥身份。与 createConfiguredByokEnvelope 不同，
 * 此路径绝不创建目录/文件、改权限或补写密钥；缺少文件时返回空集供调用方 fail closed。
 */
export async function readConfiguredByokMasterKeys(env:NodeJS.ProcessEnv):Promise<Readonly<Record<string,string>>>{
 const versionText=env.CREDENTIALS_MASTER_KEY_VERSION??'1'
 if(!/^[+-]?\d+$/.test(versionText.trim()))throw new Error('凭据主密钥版本无效')
 const version=Number(versionText)
 if(!Number.isSafeInteger(version)||version<1)throw new Error('凭据主密钥版本无效')
 let current=env.CREDENTIALS_MASTER_KEY
 if(!current){
  const normalized=Object.fromEntries(Object.entries(env).map(([name,value])=>[name.toLowerCase(),value]))
  let nested:unknown
  if(normalized.byok!==undefined){try{const value:unknown=JSON.parse(normalized.byok as string);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();nested=(value as Record<string,unknown>).master_key}catch{throw new Error('BYOK 环境配置无效')}}
  const configured=normalized.byok__master_key??nested
  if(configured!==undefined&&typeof configured!=='string')throw new Error('BYOK 环境配置无效')
  current=configured as string|undefined
 }
 const path=resolveByokKeyFile(env)
 if(!current&&path){
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../')
  const within=(base:string,target:string)=>{const rel=relative(base,target);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel))}
  if(within(root,path))throw new Error('凭据主密钥路径不能位于同步工作区')
  try{
   const parent=await realpath(dirname(path))
   const anchored=resolve(parent,basename(path))
   if(within(await realpath(root),anchored))throw new Error('凭据主密钥路径不能位于同步工作区')
   if(anchored!==path)throw new Error('凭据主密钥目录不可安全解析')
   const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
   try{
    const metadata=await file.stat()
    if(!metadata.isFile()||metadata.size>4096||(metadata.mode&0o077)!==0)throw new Error('凭据主密钥文件权限或格式无效')
    current=(await file.readFile('ascii')).trim()
    if(!current)throw new Error('凭据主密钥文件为空')
   }finally{await file.close()}
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')current=undefined;else throw error}
 }
 const previous=env.CREDENTIALS_MASTER_KEY_PREVIOUS
 return Object.freeze(current?{[String(version)]:current,...(previous&&version>1?{[String(version-1)]:previous}:{})}:{})
}

/** 调用者提供部署环境，密钥按需加载。 */
export function createConfiguredByokEnvelope(env:NodeJS.ProcessEnv){
 const versionText=env.CREDENTIALS_MASTER_KEY_VERSION??'1'
 if(!/^[+-]?\d+$/.test(versionText.trim()))throw new Error('凭据主密钥版本无效')
 const version=Number(versionText)
 if(!Number.isSafeInteger(version))throw new Error('凭据主密钥版本无效')
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../')
 const keyFile=resolveByokKeyFile(env)
 let masterKey=env.CREDENTIALS_MASTER_KEY
 if(!masterKey){
  const normalized=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toLowerCase(),value]))
  let nested:unknown
  if(normalized.byok!==undefined){const value:unknown=JSON.parse(normalized.byok);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('BYOK 环境配置无效');nested=(value as Record<string,unknown>).master_key}
  const configured=normalized.byok__master_key??nested
  if(configured!==undefined&&typeof configured!=='string')throw new Error('BYOK 环境配置无效')
  masterKey=configured as string|undefined
 }
 return createByokEnvelope({keyFile,version,masterKey,previousKey:env.CREDENTIALS_MASTER_KEY_PREVIOUS,validateKeyFile:async(afterMkdir)=>{
  if(!keyFile)return
  const within=(base:string,target:string)=>{const rel=relative(base,target);return rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel))}
  if(within(root,keyFile))throw new Error('凭据主密钥路径不能位于同步工作区')
  if(afterMkdir&&within(await realpath(root),resolve(await realpath(dirname(keyFile)),basename(keyFile))))throw new Error('凭据主密钥路径不能位于同步工作区')
 }})
}

export function createByokEnvelope(options:ByokEnvelopeOptions){
 const keyFile=options.keyFile
 async function current():Promise<string>{
  if(options.masterKey)return options.masterKey
  if(!keyFile)throw new Error('未配置凭据主密钥')
  let pending=keyLoads.get(keyFile)
  if(!pending){
   pending=(async()=>{
    await options.validateKeyFile?.(false)
    await mkdir(dirname(keyFile),{recursive:true})
    if(process.platform!=='linux')throw new Error('文件主密钥需要 Linux 目录句柄支持；请配置环境主密钥')
    const directory=await open(dirname(keyFile),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try{
     await options.validateKeyFile?.(true)
     const [opened,named]=await Promise.all([directory.stat(),stat(dirname(keyFile))])
     if(opened.dev!==named.dev||opened.ino!==named.ino)throw new Error('凭据主密钥目录已变更')
     const anchored=`/proc/self/fd/${directory.fd}/${basename(keyFile)}`
     try{return await readExisting(anchored)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
     const raw=randomBytes(32).toString('base64url')
     try{const file=await open(anchored,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(raw+'\n');await file.sync()}finally{await file.close()}return raw}
     catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;return await readExisting(anchored)}
    }finally{await directory.close()}
   })().finally(()=>{keyLoads.delete(keyFile)})
   keyLoads.set(keyFile,pending)
  }
  return pending
 }
 async function versionKey(version:number){const previous=version===options.version-1?await options.previousKey:undefined;return key(previous||await current())}
 return {
  async encrypt(plaintext:string,allowEmpty=false):Promise<ByokEnvelope>{if(!plaintext&&!allowEmpty)throw new Error('凭据不能为空');const data=randomBytes(32),nonce=randomBytes(12),wrap=randomBytes(12);return {ciphertext:encrypt(data,nonce,Buffer.from(plaintext),info).toString('base64'),nonce:nonce.toString('base64'),encryptedDataKey:Buffer.concat([wrap,encrypt(await versionKey(options.version),wrap,data,`b'${info}':${options.version}`)]).toString('base64'),keyVersion:options.version}},
  async decrypt(row:ByokEnvelope):Promise<string>{const wrapped=Buffer.from(row.encryptedDataKey,'base64');const data=decrypt(await versionKey(row.keyVersion),wrapped.subarray(0,12),wrapped.subarray(12),`b'${info}':${row.keyVersion}`);return decrypt(data,Buffer.from(row.nonce,'base64'),Buffer.from(row.ciphertext,'base64'),info).toString('utf8')},
 }
}

/** 与 Python 信封兼容；调用方负责从安全存储提供主密钥。 */
export function encryptByokEnvelope(plaintext: string, rawKey: string, keyVersion: number) {
  if (!plaintext || !rawKey || !Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new TypeError('凭据加密参数无效')
  const dataKey = randomBytes(32), nonce = randomBytes(12), wrapNonce = randomBytes(12)
  return { ciphertext: encrypt(dataKey, nonce, Buffer.from(plaintext), 'gugu-byok-envelope-v1').toString('base64'), nonce: nonce.toString('base64'),
    encryptedDataKey: Buffer.concat([wrapNonce, encrypt(key(rawKey), wrapNonce, dataKey, `b'gugu-byok-envelope-v1':${keyVersion}`)]).toString('base64'), keyVersion }
}
/** 兼容 Python BYOK 信封；密钥由宿主显式提供，不读取或生成用户配置。 */
export function decryptByokCredential(row: Pick<ByokCredential, 'encrypted_value' | 'nonce' | 'encrypted_data_key' | 'key_version'>, keyForVersion: (version: number) => string): string {
  const raw = keyForVersion(row.key_version)
  if (!raw) throw new Error('凭据主密钥不可用')
  const wrapped = Buffer.from(row.encrypted_data_key, 'base64')
  const dataKey = decrypt(key(raw), wrapped.subarray(0, 12), wrapped.subarray(12), `b'gugu-byok-envelope-v1':${row.key_version}`)
  return decrypt(dataKey, Buffer.from(row.nonce, 'base64'), Buffer.from(row.encrypted_value, 'base64'), 'gugu-byok-envelope-v1').toString('utf8')
}
