import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {createVoicePresetsReader} from '@gugu/core/agent/config/voice-presets-read'
import {readConfigOverride} from '../../adapters/config-override-file.js'
export function createVoicePresetsFileReader(path:string) {return createVoicePresetsReader(()=>readConfigOverride(path))}
export interface VoicePresetsReadOptions {requireAdmin:preHandlerHookHandler;read:ReturnType<typeof createVoicePresetsFileReader>}
export function registerVoicePresetsReadRoute(app:FastifyInstance,options:VoicePresetsReadOptions):void {
 app.get('/api/v1/admin/agent/voice-presets',{preHandler:options.requireAdmin},()=>options.read())
}
