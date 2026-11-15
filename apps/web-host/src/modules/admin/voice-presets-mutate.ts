import {randomUUID} from 'node:crypto'
import type {FastifyInstance,FastifyReply,preHandlerHookHandler} from 'fastify'
import {createVoicePresetMutations,VoicePresetMutationError,VoicePresetMutationUnavailable} from '@gugu/core/agent/config/voice-presets-mutate'
import {mutateConfigOverride} from '../../adapters/config-override-file.js'
import {createPosixConfigFileLock} from '../../adapters/posix-config-lock.js'
export function createVoicePresetFileMutations(path:string){
 return createVoicePresetMutations(work=>mutateConfigOverride(path,work,createPosixConfigFileLock()),()=>`v_${randomUUID().replaceAll('-','').slice(0,8)}`)
}
export interface VoicePresetMutationOptions {requireAdmin:preHandlerHookHandler;operations:ReturnType<typeof createVoicePresetFileMutations>}
export function registerVoicePresetMutationRoutes(app:FastifyInstance,options:VoicePresetMutationOptions):void {
 const preHandler=options.requireAdmin
 const execute=async(work:()=>Promise<unknown>,reply:FastifyReply)=>{try{return await work()}catch(error){if(error instanceof VoicePresetMutationError||error instanceof VoicePresetMutationUnavailable)return reply.code(error.statusCode).send({detail:error.message});throw error}}
 app.post<{Body:unknown}>('/api/v1/admin/agent/voice-presets',{preHandler},(request,reply)=>execute(()=>options.operations.create(request.body),reply))
 app.put<{Params:{preset_id:string};Body:unknown}>('/api/v1/admin/agent/voice-presets/:preset_id',{preHandler},(request,reply)=>execute(()=>options.operations.update(request.params.preset_id,request.body),reply))
 app.delete<{Params:{preset_id:string}}>('/api/v1/admin/agent/voice-presets/:preset_id',{preHandler},(request,reply)=>execute(()=>options.operations.delete(request.params.preset_id),reply))
 app.post<{Params:{preset_id:string}}>('/api/v1/admin/agent/voice-presets/:preset_id/activate',{preHandler},(request,reply)=>execute(()=>options.operations.activate(request.params.preset_id),reply))
 app.post('/api/v1/admin/agent/voice-presets/deactivate',{preHandler},(_request,reply)=>execute(()=>options.operations.deactivate(),reply))
}
