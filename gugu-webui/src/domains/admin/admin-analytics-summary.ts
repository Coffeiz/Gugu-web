import type { Pool } from 'pg'
import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { adminHttpError } from './errors.js'

export type AdminAnalyticsSummaryQuery = (sql: string, values: unknown[]) => Promise<unknown[]>
export interface AdminAnalyticsSummaryOptions {
  requireAdmin: preHandlerHookHandler
  query: AdminAnalyticsSummaryQuery
  now?: () => Date
  serverTimezone?: string
}

export function createPostgresAdminAnalyticsSummaryQuery(pool: Pick<Pool, 'query'>): AdminAnalyticsSummaryQuery {
  return async (sql, values) => (await pool.query(sql, values as never[])).rows as Record<string, unknown>[]
}

function validTimezone(name: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: name }).format(); return true }
  catch { return false }
}

function zonedParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
}

function zonedMidnightUtc(now: Date, requestedZone: string | undefined, serverZone: string): Date {
  const zone = requestedZone && validTimezone(requestedZone) ? requestedZone : serverZone
  const { year, month, day } = zonedParts(now, zone)
  const localMidnightAsUtc = Date.UTC(year!, month! - 1, day!)
  const offsetAtGuess = (instant: number): number => {
    const parts = zonedParts(new Date(instant), zone)
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - instant
  }
  let midnight = localMidnightAsUtc
  midnight -= offsetAtGuess(midnight)
  // Re-evaluate after applying the offset; this handles transitions near local midnight.
  midnight = localMidnightAsUtc - offsetAtGuess(midnight)
  return new Date(midnight)
}

const SUMMARY_SQL = `
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function registerAdminAnalyticsSummaryRoute(app: FastifyInstance, options: AdminAnalyticsSummaryOptions): void {
  app.get<{ Querystring: { exclude_dev?: boolean; include_byok?: boolean; timezone?: string } }>(
    '/api/v1/admin/analytics/summary',
    {
      preHandler: options.requireAdmin,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            exclude_dev: { type: 'boolean', default: false },
            include_byok: { type: 'boolean', default: false },
            timezone: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const now = options.now?.() ?? new Date()
      const serverZone = options.serverTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai'
      const todayStart = zonedMidnightUtc(now, request.query.timezone, serverZone)
      try {
        const rows = await options.query(SUMMARY_SQL, [
          now.toISOString(), todayStart.toISOString(),
          request.query.exclude_dev ?? false, request.query.include_byok ?? false,
        ])
        const row = rows[0]
        if (!isRecord(row) || !isRecord(row.summary)) throw new Error('invalid analytics summary result')
        return row.summary
      } catch {
        throw adminHttpError(500, '分析汇总查询失败')
      }
    },
  )
}
