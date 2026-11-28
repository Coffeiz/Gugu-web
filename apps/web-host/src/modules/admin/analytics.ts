import { addUtcDaysToDateKey,dateKeyInTimeZone,startOfDateKeyInTimeZone } from '../../shared/date-time.js';

import { pythonQueryBoolean } from '../../http/python-query.js';

import type { FastifyInstance,preHandlerHookHandler } from 'fastify';

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

export type AnalyticsQuery = (sql:string,params:unknown[])=>Promise<{rows:Record<string,unknown>[]}>
const developerFilter = (alias:string) => ` AND ${alias}.user_id NOT IN (SELECT id FROM users WHERE is_developer)`
export async function readSessionDepth(query:AnalyticsQuery,excludeDev:boolean) {
 const rows=(await query(`SELECT s.user_id,MAX(t.turns)::int AS max_turns FROM (SELECT session_id,COUNT(*) AS turns FROM conversation_messages WHERE role='user' GROUP BY session_id) t JOIN conversation_sessions s ON s.id=t.session_id WHERE TRUE ${excludeDev?developerFilter('s'):''} GROUP BY s.user_id`,[])).rows
 const buckets=[{label:'1',users:0},{label:'2-3',users:0},{label:'4-10',users:0},{label:'11-30',users:0},{label:'30+',users:0}]
 for(const row of rows) {const n=Number(row.max_turns);const index=n<=1?0:n<=3?1:n<=10?2:n<=30?3:4; buckets[index]!.users++}
 return {buckets,total_users:rows.length}
}
export async function readChatFunnel(query:AnalyticsQuery,excludeDev:boolean) {
 const row=(await query(`SELECT COUNT(DISTINCT user_id) FILTER(WHERE event='chat_open') AS chat_opened,COUNT(DISTINCT user_id) FILTER(WHERE event='chat_message') AS chat_msg_1,COUNT(DISTINCT user_id) FILTER(WHERE event='chat_message' AND (properties->>'turn')::int>=3) AS chat_msg_3,COUNT(DISTINCT user_id) FILTER(WHERE event='chat_expanded') AS chat_expanded FROM frontend_events e WHERE TRUE ${excludeDev?developerFilter('e'):''}`,[])).rows[0]!
 return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value)]))
}
export async function readToolDistribution(query:AnalyticsQuery,excludeDev:boolean,includeByok:boolean) {
 const rows=(await query(`SELECT elem AS tool_name,COUNT(*)::int AS calls FROM agent_usage a,jsonb_array_elements_text(tools_used::jsonb) AS elem WHERE tools_used IS NOT NULL AND jsonb_typeof(tools_used::jsonb)='array' ${excludeDev?developerFilter('a'):''} ${includeByok?'':'AND NOT is_byok'} GROUP BY elem ORDER BY calls DESC LIMIT 20`,[])).rows
 return rows.map(row=>({tool:row.tool_name,calls:Number(row.calls)}))
}
export async function readActiveDimensions(query:AnalyticsQuery,excludeDev:boolean,includeByok:boolean,now:Date) {
 const dimensions=[['chat','聊天用户','agent_usage','created_at',includeByok?'':' AND is_byok IS FALSE'],['project','项目用户','projects','updated_at',''],['calendar','日历用户','calendar_events','created_at',''],['file','文件用户','files','updated_at',' AND deleted_at IS NULL'],['reminder','提醒用户','scheduled_tasks','last_run_at','']]
 const since=new Date(now.getTime()-7*86400000)
 const results=[]
 for(const [key,label,table,time,extra] of dimensions) {
  const row=(await query(`SELECT COUNT(DISTINCT user_id) AS users FROM ${table} t WHERE ${time}>=$1 ${extra} ${excludeDev?developerFilter('t'):''}`,[since])).rows[0]!
  results.push({key,label,users:Number(row.users)})
 }
 return {window_days:7,dimensions:results}
}

export const SUMMARY_SQL = `
WITH params AS (
  SELECT $1::timestamptz AS now_at, $2::timestamptz AS today_start,
         $3::boolean AS exclude_dev, $4::boolean AS include_byok
),
allowed_users AS (
  SELECT u.id FROM users u, params p WHERE NOT p.exclude_dev OR u.is_developer IS FALSE
),
seed_project_ids AS (
  SELECT (state #>> '{seed,project_id}')::bigint AS id
  FROM onboarding_state
  WHERE state #>> '{seed,project_id}' ~ '^[0-9]+$'
),
users_stats AS (
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE u.created_at >= p.now_at - INTERVAL '7 days') AS new_7d,
         COUNT(*) FILTER (WHERE u.created_at >= p.now_at - INTERVAL '30 days') AS new_30d,
         COUNT(*) FILTER (WHERE u.created_at < p.now_at - INTERVAL '7 days') AS cohort_7d,
         COUNT(*) FILTER (WHERE u.created_at < p.now_at - INTERVAL '30 days') AS cohort_30d
  FROM users u CROSS JOIN params p
  WHERE NOT p.exclude_dev OR u.is_developer IS FALSE
),
active_7d AS (
  SELECT COUNT(*) AS value FROM (
    SELECT a.user_id FROM agent_usage a, params p
    WHERE a.created_at >= p.now_at - INTERVAL '7 days'
      AND (p.include_byok OR a.is_byok IS FALSE)
      AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = a.user_id))
    UNION
    SELECT e.user_id FROM frontend_events e, params p
    WHERE e.created_at >= p.now_at - INTERVAL '7 days'
      AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = e.user_id))
    UNION
    SELECT u.id FROM users u, params p
    WHERE u.last_active_at >= p.now_at - INTERVAL '7 days'
      AND (NOT p.exclude_dev OR u.is_developer IS FALSE)
  ) active_ids
),
active_30d AS (
  SELECT COUNT(*) AS value FROM (
    SELECT a.user_id FROM agent_usage a, params p
    WHERE a.created_at >= p.now_at - INTERVAL '30 days'
      AND (p.include_byok OR a.is_byok IS FALSE)
      AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = a.user_id))
    UNION
    SELECT e.user_id FROM frontend_events e, params p
    WHERE e.created_at >= p.now_at - INTERVAL '30 days'
      AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = e.user_id))
    UNION
    SELECT u.id FROM users u, params p
    WHERE u.last_active_at >= p.now_at - INTERVAL '30 days'
      AND (NOT p.exclude_dev OR u.is_developer IS FALSE)
  ) active_ids
),
projects_stats AS (
  SELECT COUNT(*) FILTER (WHERE pr.archived IS FALSE) AS total,
         COUNT(*) FILTER (WHERE pr.archived IS FALSE AND pr.status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE pr.archived IS FALSE AND pr.status = 'active') AS active,
         COUNT(*) FILTER (WHERE pr.archived IS FALSE AND pr.status = 'done') AS done,
         COUNT(DISTINCT pr.user_id) FILTER (WHERE pr.archived IS FALSE) AS created_project_users,
         COUNT(DISTINCT pr.user_id) FILTER (WHERE pr.status = 'done') AS completed_project_users,
         COUNT(DISTINCT pr.user_id) FILTER (
           WHERE pr.archived IS FALSE AND pr.status = 'active' AND u.created_at < p.now_at - INTERVAL '7 days'
         ) AS week_active_project_users
  FROM projects pr
  JOIN users u ON u.id = pr.user_id
  CROSS JOIN params p
  WHERE pr.id NOT IN (SELECT id FROM seed_project_ids)
    AND (NOT p.exclude_dev OR u.is_developer IS FALSE)
),
sessions_stats AS (
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE s.source = 'web' OR s.source IS NULL) AS web
  FROM conversation_sessions s, params p
  WHERE NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = s.user_id)
),
bot_platforms AS (
  SELECT COALESCE(jsonb_object_agg(platform, users), '{}'::jsonb) AS value FROM (
    SELECT b.platform, COUNT(DISTINCT b.user_id) AS users
    FROM user_bots b, params p
    WHERE b.enabled IS TRUE
      AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = b.user_id))
    GROUP BY b.platform
  ) platforms
),
bot_total AS (
  SELECT COUNT(DISTINCT b.user_id) AS value
  FROM user_bots b, params p
  WHERE b.enabled IS TRUE
    AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = b.user_id))
),
usage_stats AS (
  SELECT COUNT(*) AS calls, COALESCE(SUM(a.tokens_in), 0) AS tokens_in,
         COALESCE(SUM(a.tokens_out), 0) AS tokens_out,
         COUNT(*) FILTER (WHERE a.created_at >= p.today_start) AS today_calls,
         COALESCE(SUM(a.tokens_in) FILTER (WHERE a.created_at >= p.today_start), 0) AS today_tokens_in,
         COALESCE(SUM(a.tokens_out) FILTER (WHERE a.created_at >= p.today_start), 0) AS today_tokens_out
  FROM agent_usage a, params p
  WHERE (p.include_byok OR a.is_byok IS FALSE)
    AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = a.user_id))
),
retained_7d AS (
  SELECT COUNT(DISTINCT u.id) AS value FROM users u, params p
  WHERE u.created_at < p.now_at - INTERVAL '7 days'
    AND (NOT p.exclude_dev OR u.is_developer IS FALSE)
    AND (u.last_active_at >= u.created_at + INTERVAL '7 days' OR EXISTS (
      SELECT 1 FROM agent_usage a WHERE a.user_id = u.id
        AND a.created_at >= u.created_at + INTERVAL '7 days'
        AND (p.include_byok OR a.is_byok IS FALSE)
    ))
),
retained_30d AS (
  SELECT COUNT(DISTINCT u.id) AS value FROM users u, params p
  WHERE u.created_at < p.now_at - INTERVAL '30 days'
    AND (NOT p.exclude_dev OR u.is_developer IS FALSE)
    AND (u.last_active_at >= u.created_at + INTERVAL '30 days' OR EXISTS (
      SELECT 1 FROM agent_usage a WHERE a.user_id = u.id
        AND a.created_at >= u.created_at + INTERVAL '30 days'
        AND (p.include_byok OR a.is_byok IS FALSE)
    ))
),
second_project_users AS (
  SELECT COUNT(*) AS value FROM (
    SELECT pr.user_id FROM projects pr, params p
    WHERE pr.id NOT IN (SELECT id FROM seed_project_ids)
      AND (NOT p.exclude_dev OR EXISTS (SELECT 1 FROM allowed_users au WHERE au.id = pr.user_id))
    GROUP BY pr.user_id HAVING COUNT(pr.id) >= 2
  ) repeated_users
)
SELECT jsonb_build_object(
  'users', jsonb_build_object('total', us.total, 'wau', a7.value, 'active_30d', a30.value, 'new_7d', us.new_7d, 'new_30d', us.new_30d),
  'projects', jsonb_build_object('total', ps.total, 'pending', ps.pending, 'active', ps.active, 'done', ps.done),
  'sessions', jsonb_build_object('total', ss.total, 'web', ss.web, 'im', ss.total - ss.web),
  'im_bots', jsonb_build_object('users_with_bot', bt.value,
      'adoption_rate', CASE WHEN us.total = 0 THEN 0 ELSE ROUND(bt.value::numeric / us.total, 4) END,
      'users_by_platform', bp.value),
  'agent', jsonb_build_object('total_calls', ug.calls, 'tokens_in', ug.tokens_in, 'tokens_out', ug.tokens_out,
      'today_calls', ug.today_calls, 'today_tokens_in', ug.today_tokens_in, 'today_tokens_out', ug.today_tokens_out),
  'funnel', jsonb_build_object('registered', us.total, 'created_project', ps.created_project_users,
      'completed_project', ps.completed_project_users,
      'retention_7d', CASE WHEN us.cohort_7d = 0 THEN 0 ELSE ROUND(r7.value::numeric / us.cohort_7d, 4) END,
      'retention_30d', CASE WHEN us.cohort_30d = 0 THEN 0 ELSE ROUND(r30.value::numeric / us.cohort_30d, 4) END,
      'retained_7d', r7.value, 'retained_30d', r30.value, 'cohort_7d', us.cohort_7d, 'cohort_30d', us.cohort_30d),
  'retention_metrics', jsonb_build_object('created_project_users', ps.created_project_users,
      'second_project_users', sp.value, 'week_active_project_users', ps.week_active_project_users)
) AS summary
FROM users_stats us CROSS JOIN active_7d a7 CROSS JOIN active_30d a30
CROSS JOIN projects_stats ps CROSS JOIN sessions_stats ss CROSS JOIN bot_platforms bp
CROSS JOIN bot_total bt CROSS JOIN usage_stats ug CROSS JOIN retained_7d r7
CROSS JOIN retained_30d r30 CROSS JOIN second_project_users sp
`

/** 将IEEE754实际值按Python round(value,4)的偶数舍入规则投影。 */
function roundFour(value:number):number {
 const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value)
 const bits=view.getBigUint64(0), exponent=Number((bits>>52n)&2047n)-1023-52
 let numerator=((bits&((1n<<52n)-1n))|(1n<<52n))*10000n, denominator=1n
 if(exponent>=0)numerator<<=BigInt(exponent);else denominator<<=BigInt(-exponent)
 let rounded=numerator/denominator;const remainder=numerator%denominator
 if(remainder*2n>denominator || remainder*2n===denominator && rounded%2n===1n)rounded++
 return Number(rounded)/10000
}
export async function readAnalyticsSummary(query:AnalyticsQuery,now:Date,todayStart:Date,excludeDev:boolean,includeByok:boolean) {
 const row=(await query(SUMMARY_SQL,[now.toISOString(),todayStart.toISOString(),excludeDev,includeByok])).rows[0]
 if(!row || typeof row.summary!=='object' || row.summary===null)throw new Error('分析汇总查询失败')
 const summary=row.summary as Record<string,Record<string,number>>
 const bots=summary.im_bots!,users=summary.users!,funnel=summary.funnel!
 bots.adoption_rate=users.total ? roundFour(Number(bots.users_with_bot)/Number(users.total)):0
 for(const days of [7,30])funnel[`retention_${days}d`]=funnel[`cohort_${days}d`] ? roundFour(Number(funnel[`retained_${days}d`])/Number(funnel[`cohort_${days}d`])):0
 return summary
}

/** 日期窗口由可信Host按请求时区建立；SQL时区通过参数传递。 */
export async function readAnalyticsTrends(query:AnalyticsQuery,keys:string[],timeZone:string,start:Date,excludeDev:boolean,includeByok:boolean) {
 const params=[start,timeZone],nd=excludeDev?' AND user_id NOT IN (SELECT id FROM users WHERE is_developer)':'',agentNd=nd+(includeByok?'':' AND NOT is_byok'),userNd=excludeDev?' AND NOT is_developer':''
 const read=async(sql:string)=> (await query(sql,params)).rows
 const agent=await read(`SELECT to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,COUNT(*)::int AS calls,COALESCE(SUM(tokens_in+tokens_out),0)::bigint AS tokens FROM agent_usage WHERE created_at >= $1 ${agentNd} GROUP BY d`)
 const interactions=await read(`SELECT to_char(a.created_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,COALESCE(a.input_source,s.source) AS source,COUNT(*)::int AS calls FROM agent_usage a LEFT JOIN conversation_sessions s ON s.id=a.session_id WHERE a.created_at >= $1 AND a.scenario='chat' AND COALESCE(a.input_source,s.source) IN ('web','qq','feishu','telegram','wechat') ${excludeDev?' AND a.user_id NOT IN (SELECT id FROM users WHERE is_developer)':''} ${includeByok?'':' AND NOT a.is_byok'} GROUP BY d,COALESCE(a.input_source,s.source)`)
 const users=await read(`SELECT to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,COUNT(*)::int AS cnt FROM users WHERE created_at >= $1 ${userNd} GROUP BY d`)
 const completed=await read(`SELECT to_char(done_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,COUNT(*)::int AS cnt FROM projects WHERE done_at >= $1 ${nd} GROUP BY d`)
 const created=await read(`SELECT to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,COUNT(*)::int AS cnt FROM projects WHERE created_at >= $1 ${nd} GROUP BY d`)
 const active=await read(`SELECT d,COUNT(DISTINCT uid)::int AS cnt FROM (SELECT to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,user_id AS uid FROM agent_usage WHERE created_at >= $1 ${agentNd} UNION SELECT to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,user_id AS uid FROM frontend_events WHERE created_at >= $1 ${nd} UNION SELECT to_char(last_active_at AT TIME ZONE $2,'YYYY-MM-DD') AS d,id AS uid FROM users WHERE last_active_at >= $1 ${userNd}) t GROUP BY d`)
 const series=(rows:Record<string,unknown>[],field='cnt')=>{const map=new Map(rows.map(row=>[row.d,Number(row[field])]));return keys.map(key=>map.get(key)??0)}
 return {labels:keys.map(key=>key.slice(5).split('-').map(Number).join('/')),agent_calls:series(agent,'calls'),agent_tokens:series(agent,'tokens'),interactions_by_source:Object.fromEntries(['web','qq','feishu','telegram','wechat'].map(source=>[source,series(interactions.filter(row=>row.source===source),'calls')])),user_registrations:series(users),project_completions:series(completed),project_creations:series(created),active_users:series(active)}
}
