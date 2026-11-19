import { readConfigOverride } from '../../adapters/config/config-override-file.js'
import { pythonQueryBoolean } from '../../http/python-query.js'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import type { AttentionDefaults } from '@gugu/core/im/attention/defaults'
import { scoreAttentionSandbox, type AttentionSandboxInput } from '@gugu/core/im/attention/dev-sandbox'
import { z } from 'zod'

const platforms=['feishu','qq','wechat','telegram'] as const

function record(value:unknown):Record<string,unknown> {if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('IM平台配置无效');return value as Record<string,unknown>}

function boolean(value:unknown):boolean {
 if(value===0 || value===1)return Boolean(value)
 if(value===undefined || value===null)throw new Error('IM平台配置无效')
 return pythonQueryBoolean(value)
}

/** 与Python先构建环境配置、再合并override一致；每请求重读，不读取.env。 */
export function createImPlatformSettingsReader(env:NodeJS.ProcessEnv,overridePath:string):()=>string[] {
 return ()=>{
  const insensitive=Object.fromEntries(Object.entries(env).map(([key,value])=>[key.toLowerCase(),value]))
  const base:Record<string,boolean>=Object.fromEntries(platforms.map(platform=>[platform,true]))
  const raw=insensitive.im
  const whole=raw===undefined?{}:record(JSON.parse(raw))
  for(const platform of platforms) {
   const nested=insensitive[`im__${platform}`]
   if(nested!==undefined)base[platform]=boolean(nested)
   else if(Object.hasOwn(whole,platform))base[platform]=boolean(whole[platform])
  }
  const document=readConfigOverride(overridePath)
  let effective={...base}
  // Python apply_override在IM校验失败时放弃该override，保留有效环境配置。
  if(Object.hasOwn(document,'im'))try {
   const im=document.im===null?{}:record(document.im)
   for(const platform of platforms)if(Object.hasOwn(im,platform))effective[platform]=boolean(im[platform])
  }catch {effective=base}
  return platforms.filter(platform=>effective[platform])
 }
}

export interface AttentionDefaultsOptions {
  requireUser: preHandlerHookHandler
  read(): AttentionDefaults
  score?(input: AttentionSandboxInput, nowMs: number): unknown
}

const scoreRequest = z.object({
  text: z.string().max(20_000),
  anchor_text: z.string().max(20_000).default(''),
  before_anchor: z.array(z.string()).max(5).default([]),
  after_anchor: z.array(z.string()).max(5).default([]),
  gap_seconds: z.number().int().min(0).max(600).default(30),
  member_active_age_seconds: z.number().int().min(0).max(600).nullable().optional(),
  aliases: z.array(z.string()).max(20).default(['咕咕']),
  mode: z.enum(['quiet', 'natural', 'active', 'autonomous']).default('natural'),
  snapshot_complete: z.boolean().default(true),
}).strict()

export function registerAttentionDefaultsRoute(app: FastifyInstance, options: AttentionDefaultsOptions): void {
  app.get('/api/v1/dev/attention/defaults', { preHandler: options.requireUser }, () => options.read())
  app.post('/api/v1/dev/attention/score', { preHandler: options.requireUser }, async (request, reply) => {
    const parsed = scoreRequest.safeParse(request.body)
    if (!parsed.success) return reply.code(422).send({ detail: '注意力评分参数无效' })
    return (options.score ?? scoreAttentionSandbox)(parsed.data, Date.now())
  })
}
