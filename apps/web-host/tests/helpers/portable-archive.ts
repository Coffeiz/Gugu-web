import {spawnSync} from 'node:child_process'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

/** 仅合成测试密钥；Python产物用于跨语言契约，不读取运行配置。 */
export function writePythonPortableArchive(path:string,context:string,plain:Uint8Array):void{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),python=process.env.GUGU_CORE_GOLDEN_PYTHON
 if(!python)throw new Error('需要隔离Python参考运行时')
 const script="from types import SimpleNamespace; import sys; from app.services.data_portability import crypto_stream as c; c.get_settings=lambda:SimpleNamespace(secret_key='synthetic-secret'); f=open(sys.argv[1],'wb'); w=c.EncryptedArchiveWriter(f,sys.argv[2]); w.write(sys.stdin.buffer.read()); w.finish(); f.close()"
 const result=spawnSync(python,['-c',script,path,context],{cwd:root,env:{...process.env,PYTHONPATH:join(root,'backend'),GUGU_ENV_FILE:'/dev/null',GUGU_CONFIG_OVERRIDE_FILE:`${path}.not-created`},input:plain})
 if(result.status!==0)throw new Error('Python参考归档构造失败')
}
