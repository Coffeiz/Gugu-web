import type {FastifyInstance,FastifyRequest,preHandlerHookHandler} from 'fastify'
import {z} from 'zod'
import {redactToolError} from '@gugu/core/agent'
import type {createUserSkillManager} from '@gugu/core/agent/skills/user-management'
import {pythonQueryBoolean} from '../../http/python-query.js'
const text=(max:number)=>z.string().refine(value=>Array.from(value).length>=1&&Array.from(value).length<=max)
const bool=z.preprocess(value=>{try{return value===0||value===1?Boolean(value):pythonQueryBoolean(value)}catch{return value}},z.boolean())
const create=z.object({name:text(120),description_short:text(100),description_long:z.string().max(500).nullable().default(null),category:z.string().max(32).default('personal'),related_tools:z.array(z.string()).max(32).default([]),body:text(20000),enabled:bool.default(true)})
const patch=create.partial().extend({name:text(120).nullable().optional(),description_short:text(100).nullable().optional(),category:z.string().max(32).nullable().optional(),body:text(20000).nullable().optional(),related_tools:z.array(z.string()).max(32).nullable().optional(),enabled:bool.nullable().optional()})
type Manager=ReturnType<typeof createUserSkillManager>
type Tool={name:string;description_short:string;category:string;enabled:boolean}
export interface UserSkillManagementOptions {requireUser:preHandlerHookHandler;ownerIdFromRequest(request:FastifyRequest):string;operations:Manager;tools(owner:string):Promise<Tool[]>}
export function registerUserSkillManagementRoutes(app:FastifyInstance,options:UserSkillManagementOptions){
 app.get('/api/v1/skills',{preHandler:options.requireUser},async(request,reply)=>{
  const value=(request.query as Record<string,unknown>).include_tools;let include=true
  try{if(value!==undefined)include=pythonQueryBoolean(value)}catch{return reply.code(422).send({detail:'技能查询参数无效'})}
  const owner=options.ownerIdFromRequest(request),skills=await options.operations.list(owner),tools=include?await options.tools(owner):[]
  return {skills,tools}
 })
 app.get('/api/v1/skills/tools',{preHandler:options.requireUser},async request=>({tools:await options.tools(options.ownerIdFromRequest(request))}))
 app.post('/api/v1/skills',{preHandler:options.requireUser},async(request,reply)=>{
  const input=create.safeParse(request.body);if(!input.success)return reply.code(422).send({detail:'技能参数无效'})
  try{return reply.code(201).send(await options.operations.create(options.ownerIdFromRequest(request),input.data))}catch(error){if(error instanceof Error&&error.name==='UserSkillValidationError')return reply.code(422).send({detail:redactToolError(error.message)});throw error}
 })
 app.patch<{Params:{skill_id:string}}>('/api/v1/skills/:skill_id',{preHandler:options.requireUser},async(request,reply)=>{
  const input=patch.safeParse(request.body);if(!input.success)return reply.code(422).send({detail:'技能参数无效'})
  try{return await options.operations.update(options.ownerIdFromRequest(request),request.params.skill_id,input.data)}catch(error){if(error instanceof Error&&error.name==='UserSkillValidationError')return reply.code(422).send({detail:redactToolError(error.message)});throw error}
 })
}
