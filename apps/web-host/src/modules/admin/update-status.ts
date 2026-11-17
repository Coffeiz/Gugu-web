import type {FastifyInstance,preHandlerHookHandler} from 'fastify'

export type AdminUpdateMode = 'integrated_compose' | 'split_compose' | 'standalone_app_bundle' | 'unknown'

export function resolveAdminUpdateMode(value: string | undefined): AdminUpdateMode {
  switch (value?.trim().toLowerCase()) {
    case 'integrated_compose': return 'integrated_compose'
    case 'split_compose': return 'split_compose'
    case 'standalone_app_bundle':
    case 'standalone_docker': return 'standalone_app_bundle'
    default: return 'unknown'
  }
}

export function registerAdminUpdateStatusRoute(app:FastifyInstance,options:{requireAdmin:preHandlerHookHandler;mode:AdminUpdateMode}):void{
 app.get('/api/v1/admin/update/status',{preHandler:options.requireAdmin},async()=>{
  if(options.mode==='integrated_compose'||options.mode==='split_compose')return{
   enabled:false,mode:options.mode,capability:'manual',reason_code:'manual_image_update',
   reason:'Compose 部署由 Docker/Compose 管理器更新整套镜像；Admin 不执行镜像更新。',
   current:null,candidate:null,has_update:false,task:null,history:[],
  }
  if(options.mode==='standalone_app_bundle')return{
   enabled:false,mode:options.mode,capability:'manual',reason_code:'node_updater_unavailable',
   reason:'当前 Node Web Host 未接入签名应用包更新器，请按部署说明手动更新。',
   current:null,candidate:null,has_update:false,task:null,history:[],
  }
  return{
   enabled:false,mode:'unknown',capability:'manual',reason_code:'deployment_unrecognized',
   reason:'无法可靠识别 Node Web Host 部署模式，自动更新已关闭。',
   current:null,candidate:null,has_update:false,task:null,history:[],
  }
 })
}
