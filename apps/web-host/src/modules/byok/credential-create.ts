import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'
import {pythonQueryBoolean} from '../../http/python-query.js'
const bool=z.preprocess(value=>{if(value===0||value===1)return Boolean(value);try{return pythonQueryBoolean(value)}catch{return value}},z.boolean())
const integer=z.preprocess(value=>{if(typeof value==='boolean')return Number(value);if(typeof value==='string'&&/^[+-]?\d(?:_?\d)*(?:\.0+)?$/.test(value.trim()))return Number(value.trim().replaceAll('_',''));return value},z.number().int())
import type {createCredentialCreator} from '@gugu/core/byok/credential-create'
const schema=z.object({provider:z.string().min(1).max(64),capability:z.enum(['llm','deep_research','similar_image_search','speech_to_text','embedding']),value:z.string().max(20000).default(''),api_format:z.string().max(32).default(''),base_url:z.string().max(500).default(''),model:z.string().max(200).default(''),dimensions:integer.pipe(z.number().min(0).max(65536)).nullish(),max_tokens:integer.nullish(),context_tokens:integer.nullish(),thinking:z.enum(['disabled','adaptive']).nullish(),reasoning_effort:z.enum(['','none','minimal','low','medium','high','xhigh','max']).nullish(),reasoning_persistence:z.enum(['off','continuation']).default('off'),web_search_enabled:bool.nullish(),image:bool.default(false),video:bool.default(false),audio:bool.default(false),image_detail:z.enum(['auto','low','high','original']).default('auto')})
export interface CredentialCreateOptions{requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;create:ReturnType<typeof createCredentialCreator>}
export function registerCredentialCreateRoute(app:FastifyInstance,options:CredentialCreateOptions):void {
 app.post('/api/v1/byok',{preHandler:options.requireUser},async(request,reply)=>{const body=schema.safeParse(request.body);if(!body.success)return reply.code(422).send({detail:'凭据参数无效'});return options.create(options.ownerIdFromRequest(request),body.data)})
}
