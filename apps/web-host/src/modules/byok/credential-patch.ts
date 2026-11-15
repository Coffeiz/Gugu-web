import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'
import {pythonQueryBoolean} from '../../http/python-query.js'
import type {createCredentialPatch} from '@gugu/core/byok/credential-patch'

const bool=z.preprocess(value=>{if(value===0||value===1)return Boolean(value);try{return pythonQueryBoolean(value)}catch{return value}},z.boolean())
const nullableBool=bool.nullable().optional()
const integer=z.preprocess(value=>{if(typeof value==='boolean')return Number(value);if(typeof value==='string'&&/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(value.trim()))return Number(value.trim().replaceAll('_',''));return value},z.number().int())
const nullableInteger=integer.nullable().optional()
const schema=z.object({provider:z.string().min(1).max(64).nullable().optional(),value:z.string().max(20000).nullable().optional(),api_format:z.string().max(32).nullable().optional(),base_url:z.string().max(500).nullable().optional(),model:z.string().max(200).nullable().optional(),dimensions:nullableInteger.pipe(z.number().min(0).max(65536).nullable().optional()),max_tokens:nullableInteger,context_tokens:nullableInteger,thinking:z.enum(['disabled','adaptive']).nullable().optional(),reasoning_effort:z.enum(['','none','minimal','low','medium','high','xhigh','max']).nullable().optional(),reasoning_persistence:z.enum(['off','continuation']).nullable().optional(),web_search_enabled:nullableBool,image:nullableBool,video:nullableBool,audio:nullableBool,image_detail:z.enum(['auto','low','high','original']).nullable().optional(),enabled:nullableBool})
export interface CredentialPatchRouteOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;patch:ReturnType<typeof createCredentialPatch>}
export function registerCredentialPatchRoute(app:FastifyInstance,options:CredentialPatchRouteOptions):void{
 app.patch<{Params:{credential_id:string}}>('/api/v1/byok/:credential_id',{preHandler:options.requireUser},async(request,reply)=>{
  const id=Number(request.params.credential_id),body=schema.safeParse(request.body)
  if(!Number.isSafeInteger(id)||!body.success)return reply.code(422).send({detail:'凭据参数无效'})
  return options.patch(options.ownerIdFromRequest(request),id,body.data)
 })
}
