import {readAnalyticsSummary} from '@gugu/core/admin/analytics-summary'
import {readAnalyticsTrends} from '@gugu/core/admin/analytics-trends'
import {dateKeyInTimeZone,addUtcDaysToDateKey,startOfDateKeyInTimeZone} from '../../shared/date-time.js'
import {pythonQueryBoolean} from '../../http/python-query.js'
import type {FastifyInstance,preHandlerHookHandler} from 'fastify'
import {readSessionDepth,readChatFunnel,readToolDistribution,readActiveDimensions,type AnalyticsQuery} from '@gugu/core/admin/analytics'
export interface AdminAnalyticsOptions {requireAdmin:preHandlerHookHandler;query:AnalyticsQuery;now?:()=>Date}
/** 认证与DTO留在Host；聚合统计由Core执行。 */
export function registerAdminAnalyticsRoutes(app:FastifyInstance,options:AdminAnalyticsOptions):void {
 const timeZone=(requested:unknown)=>{const fallback=Intl.DateTimeFormat().resolvedOptions().timeZone;try {if(typeof requested==='string' && requested){new Intl.DateTimeFormat('en',{timeZone:requested});return requested}}catch {} return fallback}
 app.get<{Querystring:{exclude_dev?:unknown;include_byok?:unknown;timezone?:unknown}}>('/api/v1/admin/analytics/summary',{preHandler:options.requireAdmin},request=>{
  const now=options.now?.()??new Date(),zone=timeZone(request.query.timezone)
  return readAnalyticsSummary(options.query,now,startOfDateKeyInTimeZone(dateKeyInTimeZone(now,zone),zone),pythonQueryBoolean(request.query.exclude_dev),pythonQueryBoolean(request.query.include_byok))
 })
 app.get<{Querystring:{exclude_dev?:unknown;include_byok?:unknown;timezone?:unknown;days?:string}}>('/api/v1/admin/analytics/trends',{preHandler:options.requireAdmin},request=>{
  const raw=request.query.days??'30',days=Number(raw)
  if(!/^[-+]?\d+$/.test(raw)||!Number.isInteger(days)||days<7||days>90)throw Object.assign(new Error('天数必须为7到90的整数'),{statusCode:422})
  const now=options.now?.()??new Date(),zone=timeZone(request.query.timezone),first=addUtcDaysToDateKey(dateKeyInTimeZone(now,zone),1-days),keys=Array.from({length:days},(_,index)=>addUtcDaysToDateKey(first,index))
  return readAnalyticsTrends(options.query,keys,zone,startOfDateKeyInTimeZone(first,zone),pythonQueryBoolean(request.query.exclude_dev),pythonQueryBoolean(request.query.include_byok))
 })
 const operations={
  'session-depth':(exclude:boolean,_byok:boolean)=>readSessionDepth(options.query,exclude),
  'chat-funnel':(exclude:boolean,_byok:boolean)=>readChatFunnel(options.query,exclude),
  'tool-distribution':(exclude:boolean,byok:boolean)=>readToolDistribution(options.query,exclude,byok),
  'active-dimensions':(exclude:boolean,byok:boolean)=>readActiveDimensions(options.query,exclude,byok,options.now?.()??new Date()),
 }
 for(const [path,read] of Object.entries(operations)) app.get<{Querystring:{exclude_dev?:boolean;include_byok?:boolean}}>(`/api/v1/admin/analytics/${path}`,{
  preHandler:options.requireAdmin,
 },request=>read(pythonQueryBoolean(request.query.exclude_dev),pythonQueryBoolean(request.query.include_byok)))
}
