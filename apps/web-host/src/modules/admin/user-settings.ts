import type {FastifyInstance, FastifyRequest, preHandlerHookHandler} from 'fastify'
import type {Pool} from 'pg'
import {updateAdminUserSettings, type AdminSettingsTransaction} from '@gugu/core/admin/user-settings'
import {withPostgresTransaction} from '../../adapters/postgres-transaction.js'

export function createPostgresAdminSettingsTransaction(pool: Pick<Pool,'connect'>): AdminSettingsTransaction {
  return work => withPostgresTransaction(pool, client => work(async (sql, values) => client.query(sql,values)))
}
export interface AdminUserSettingsOptions {
  requireAdmin: preHandlerHookHandler
  transaction: AdminSettingsTransaction
  writeAuditLog: (username:string, action:string, description:string, request:FastifyRequest)=>Promise<void>
  adminUsername: (request:FastifyRequest)=>string
}
export function registerAdminUserSettingsRoutes(app:FastifyInstance, options:AdminUserSettingsOptions):void {
  app.patch<{Params:{user_id:string}; Body:Record<string,unknown>}>('/api/v1/admin/users/:user_id/quota', {
    preHandler:options.requireAdmin, schema:{body:{type:'object',additionalProperties:true}},
  }, async request => {
    const result = await updateAdminUserSettings(options.transaction,request.params.user_id,{kind:'quota',body:request.body})
    await options.writeAuditLog(options.adminUsername(request),'user',result.description,request)
    return result.response
  })
  app.patch<{Params:{user_id:string}}>('/api/v1/admin/users/:user_id/developer', {preHandler:options.requireAdmin}, async request => {
    const result = await updateAdminUserSettings(options.transaction,request.params.user_id,{kind:'developer'})
    await options.writeAuditLog(options.adminUsername(request),'user',result.description,request)
    return result.response
  })
}
