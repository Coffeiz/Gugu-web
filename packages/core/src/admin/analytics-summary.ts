import type {AnalyticsQuery} from './analytics.js'
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
