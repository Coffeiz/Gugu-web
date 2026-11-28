import type { FastifyInstance,preHandlerHookHandler } from 'fastify'

import { adminHttpError } from './errors.js'

import type { Pool } from 'pg'
import { createAdminUserStatusOperations, type AdminUserStatusStore } from './user-status.js'

import type { FastifyRequest } from 'fastify'

import { withPostgresTransaction } from '../../adapters/database/postgres-transaction.js'


import { toUtcIsoWithOffset } from '../../shared/date-time.js'


import type { createAdminUserBanToggle } from './user-management.js'

import { CoreError } from '@gugu/core'


import { z } from 'zod'



import { updateAdminUserSettings,type AdminSettingsTransaction } from './user-management.js'




export interface AdminUsersOptions {
  requireAdmin: preHandlerHookHandler
  read: (search?: string) => Promise<{ items: Record<string, unknown>[]; total: number }>
}

export interface AdminUserRiskOptions {
  requireAdmin: preHandlerHookHandler
  read: (windowMinutes?: number) => Promise<{
    items: Record<string, unknown>[]
    total: number
    window_minutes: number
    policy_window_minutes: number
  }>
}

export function registerAdminUsersRoute(app: FastifyInstance, options: AdminUsersOptions): void {
  app.get<{ Querystring: { q?: string } }>(
    '/api/v1/admin/users',
    {
      preHandler: options.requireAdmin,
      schema: { querystring: { type: 'object', properties: { q: { type: 'string' } } } },
    },
    async request => {
      try {
        return await options.read(request.query.q)
      } catch {
        throw adminHttpError(500, '用户列表查询失败')
      }
    },
  )
}

export function registerAdminUserRiskRoute(app: FastifyInstance, options: AdminUserRiskOptions): void {
  app.get<{ Querystring: { window_minutes?: number } }>(
    '/api/v1/admin/users/risk',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: { window_minutes: { type: 'integer', minimum: 1, maximum: 43_200, default: 1_440 } },
        },
      },
    },
    async request => {
      try {
        return await options.read(request.query.window_minutes ?? 1_440)
      } catch {
        throw adminHttpError(500, '风险用户查询失败')
      }
    },
  )
}

export interface AdminUserStatusRouteOptions {
  requireAdmin: preHandlerHookHandler
  store: AdminUserStatusStore
  /** 必须在状态事务提交后发布；异常会按 Python events helper 语义忽略。 */
  publishAuthStateChanged: (userId: string) => Promise<unknown>
  /** 与 Python write_log 对齐，必须实际写入审计记录。 */
  writeAuditLog: (adminUsername: string, action: 'user', description: string, request: FastifyRequest) => Promise<void>
  adminUsername?: (request: FastifyRequest) => string
  now?: () => Date
}

function utcIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return toUtcIsoWithOffset(value)
}

function createStatusRoutesOptions(options: AdminUserStatusRouteOptions) {
  return { preHandler: options.requireAdmin }
}

function adminUsername(options: AdminUserStatusRouteOptions, request: FastifyRequest): string {
  return options.adminUsername?.(request) ?? 'admin'
}

export function registerAdminUserStatusRoutes(app: FastifyInstance, options: AdminUserStatusRouteOptions): void {
  app.post<{
    Params: { user_id: string }
    Body: { duration_seconds?: number; reason?: string; confirm?: boolean }
  }>(
    '/api/v1/admin/users/:user_id/suspend',
    {
      ...createStatusRoutesOptions(options),
      schema: {
        params: {
          type: 'object', required: ['user_id'],
          properties: { user_id: { type: 'string' } },
        },
        body: {
          type: 'object',
          properties: {
            duration_seconds: { type: 'integer', minimum: 60, maximum: 2_592_000, default: 1_800 },
            reason: { type: 'string', minLength: 1, maxLength: 200, default: 'repeated_ownership_denied' },
            confirm: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (request) => {
      const body = request.body ?? {}
      if (body.confirm !== true) throw adminHttpError(400, '冻结操作需要确认')
      const durationSeconds = body.duration_seconds ?? 1_800
      const reason = body.reason ?? 'repeated_ownership_denied'
      const now = options.now?.() ?? new Date()
      const operations = createAdminUserStatusOperations({
        store: options.store,
        publishAuthStateChanged: options.publishAuthStateChanged,
        writeAuditLog: description => options.writeAuditLog(adminUsername(options, request), 'user', description, request),
      })
      const user = await operations.suspend(request.params.user_id, durationSeconds, reason, now)
      if (!user) throw adminHttpError(404, '用户不存在')

      return {
        id: request.params.user_id,
        account_status: user.account_status,
        is_active: user.is_active,
        suspended_until: utcIso(user.suspended_until),
      }
    },
  )

  app.post<{ Params: { user_id: string } }>(
    '/api/v1/admin/users/:user_id/unsuspend',
    {
      ...createStatusRoutesOptions(options),
      schema: {
        params: {
          type: 'object', required: ['user_id'],
          properties: { user_id: { type: 'string' } },
        },
      },
    },
    async (request) => {
      const now = options.now?.() ?? new Date()
      const operations = createAdminUserStatusOperations({
        store: options.store,
        publishAuthStateChanged: options.publishAuthStateChanged,
        writeAuditLog: description => options.writeAuditLog(adminUsername(options, request), 'user', description, request),
      })
      const user = await operations.unsuspend(request.params.user_id, now)
      if (!user) throw adminHttpError(404, '用户不存在')

      return { id: request.params.user_id, account_status: user.account_status, is_active: user.is_active }
    },
  )
}

export interface AdminUserBanOptions{
 requireAdmin:preHandlerHookHandler
 adminUsername(request:FastifyRequest):string
 toggle:ReturnType<typeof createAdminUserBanToggle>
}
export function registerAdminUserBanRoute(app:FastifyInstance,options:AdminUserBanOptions):void{
 app.patch<{Params:{user_id:string}}>('/api/v1/admin/users/:user_id/ban',{preHandler:options.requireAdmin},request=>{
  const forwarded=request.headers['x-forwarded-for']
  const ip=typeof forwarded==='string'?forwarded.split(',')[0]!.trim():request.ip||null
  return options.toggle(request.params.user_id,{operator:options.adminUsername(request),ip:ip===null?null:Array.from(ip).slice(0,60).join('')})
 })
}

export interface AdminUserDeleteOptions {
  requireAdmin:preHandlerHookHandler
  adminUsername(request:FastifyRequest):string
  deleteUser(userId:string):Promise<{username:string;storageObjectsRemoved:number}>
  writeAuditLog(username:string,action:'user',description:string,request:FastifyRequest):Promise<void>
}

const userIdSchema=z.string().uuid()
export function registerAdminUserDeleteRoute(app:FastifyInstance,options:AdminUserDeleteOptions):void{
  app.delete<{Params:{user_id:string}}>('/api/v1/admin/users/:user_id',{preHandler:options.requireAdmin},async(request,reply)=>{
    const id=userIdSchema.safeParse(request.params.user_id)
    if(!id.success)return reply.code(422).send({detail:'用户 ID 无效'})
    try{
      const result=await options.deleteUser(id.data)
      await options.writeAuditLog(options.adminUsername(request),'user',
        `删除用户 ${result.username}（存储对象清除 ${result.storageObjectsRemoved} 个）`,request)
      return {deleted:true,storage_objects_removed:result.storageObjectsRemoved}
    }catch(error){
      if(error instanceof CoreError){
        const status=error.code==='not_found'?404:error.code==='conflict'?409:400
        return reply.code(status).send({detail:error.message})
      }
      throw error
    }
  })
}

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

export interface AdminUserSecurityEventItem {
  id: number
  event_type: string
  resource_type: string
  resource_fingerprint: string
  owner_fingerprint: string | null
  client_fingerprint: string | null
  ip_fingerprint: string | null
  action: string
  reason_code: string
  occurred_at: string
}
export interface AdminUserSecurityEventOptions {
  requireAdmin: preHandlerHookHandler
  read: (userId: string, limit: number) => Promise<{ items: AdminUserSecurityEventItem[] } | null>
}

export function registerAdminUserSecurityEventRoute(app: FastifyInstance, options: AdminUserSecurityEventOptions): void {
  app.get<{ Params: { user_id: string }; Querystring: { limit?: number } }>(
    '/api/v1/admin/users/:user_id/security-events',
    {
      preHandler: options.requireAdmin,
      schema: {
        params: {
          type: 'object', required: ['user_id'],
          properties: { user_id: { type: 'string', format: 'uuid' } },
        },
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
        },
      },
    },
    async (request) => {
      const userId = request.params.user_id
      const limit = request.query.limit ?? 100
      let result: { items: AdminUserSecurityEventItem[] } | null
      try {
        result = await options.read(userId, limit)
      } catch {
        throw adminHttpError(500, '用户安全事件查询失败')
      }
      if (!result) throw adminHttpError(404, '用户不存在')
      return result
    },
  )
}
