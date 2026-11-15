import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {testSmtp,type SmtpTestInput,type SmtpTestSettings} from '@gugu/core/email/smtp-test'
import {readConfigOverride} from '../../adapters/config-override-file.js'
import {createSmtpTestDelivery} from '../../adapters/smtp-test-delivery.js'
import {pythonQueryBoolean} from '../../http/python-query.js'
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function portValue(value:unknown):number|null {
 if(typeof value==='boolean')return Number(value)
 const text=typeof value==='string'?value.trim():''
 const port=typeof value==='number'?value:/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(text)?Number(text.replaceAll('_','')):NaN
 return Number.isSafeInteger(port)?port:null
}
export function readSmtpFileSettings(env:NodeJS.ProcessEnv,path:string) {
  const normalized=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toUpperCase(),value]))
  const base:unknown=normalized.SMTP===undefined?{}:JSON.parse(normalized.SMTP)
  if(!object(base))throw new Error('SMTP环境配置无效')
  const settings:Record<string,unknown>={host:'',port:465,user:'',password:'',from_addr:'',to_addr:'',test_to_addr:'',use_ssl:true,...base}
  for(const key of ['host','port','user','password','from_addr','to_addr','test_to_addr','use_ssl'])if(normalized[`SMTP__${key.toUpperCase()}`]!==undefined)settings[key]=normalized[`SMTP__${key.toUpperCase()}`]
  const override=readConfigOverride(path).smtp
  if(override!==undefined){if(!object(override))throw new Error('SMTP配置无效');Object.assign(settings,override)}
  for(const key of ['host','user','password','from_addr','to_addr','test_to_addr'])if(typeof settings[key]!=='string')throw new Error('SMTP配置无效')
  const port=portValue(settings.port);if(port===null||port===undefined)throw new Error('SMTP端口配置无效');settings.port=port
  const secure=settings.use_ssl;settings.use_ssl=secure===0||secure===1?Boolean(secure):pythonQueryBoolean(secure)
  return settings as unknown as SmtpTestSettings&{use_ssl:boolean}
}
export function createSmtpFileProbe(env:NodeJS.ProcessEnv,path:string) {
 return async(input:SmtpTestInput)=>testSmtp(input,readSmtpFileSettings(env,path),createSmtpTestDelivery(env))
}
function parse(body:unknown):SmtpTestInput {
 if(!object(body))throw new Error('参数无效')
 const out:Record<string,unknown>={}
 for(const key of ['host','user','password','from_addr','to_addr']){if(body[key]===undefined&&['password','from_addr'].includes(key))continue;if(typeof body[key]!=='string')throw new Error('参数无效');out[key]=body[key]}
 const port=portValue(body.port);if(port===null||port===undefined)throw new Error('参数无效');out.port=port
 if(body.use_ssl!==undefined){if(body.use_ssl===null||Array.isArray(body.use_ssl))throw new Error('参数无效');out.use_ssl=body.use_ssl===0||body.use_ssl===1?Boolean(body.use_ssl):pythonQueryBoolean(body.use_ssl)}
 return out as unknown as SmtpTestInput
}
export function registerSmtpProbeRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;probe:ReturnType<typeof createSmtpFileProbe>}):void {
 app.post('/api/v1/admin/config/test-smtp',{preHandler:options.requireAdmin},async(request,reply)=>{
  let input:SmtpTestInput;try{input=parse(request.body)}catch{return reply.code(422).send({detail:'SMTP 测试参数无效'})}
  try{return await options.probe(input)}catch{return reply.code(503).send({detail:'SMTP 配置不可读取'})}
 })
}
