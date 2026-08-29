import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const sessions = sqliteTable('sessions', {
  sessionKey: text('session_key').primaryKey(),
  externalSessionId: text('external_session_id'),
  source: text('source').notNull().default('unknown'),
  title: text('title').notNull().default('Untitled session'),
  createdAt: real('created_at').notNull(),
  updatedAt: real('updated_at').notNull(),
})

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  sessionKey: text('session_key').notNull().references(() => sessions.sessionKey, { onDelete: 'cascade' }),
  traceId: text('trace_id'),
  status: text('status').notNull(),
  startedAt: real('started_at').notNull(),
  endedAt: real('ended_at'),
  durationMs: real('duration_ms'),
  inputJson: text('input_json', { mode: 'json' }).$type<unknown>().notNull(),
  outputJson: text('output_json', { mode: 'json' }).$type<unknown>().notNull(),
  attributesJson: text('attributes_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  usageJson: text('usage_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  rawJson: text('raw_json', { mode: 'json' }).$type<unknown>().notNull(),
}, table => ({ sessionStarted: index('idx_runs_session_started').on(table.sessionKey, table.startedAt) }))

export const spans = sqliteTable('spans', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  parentSpanId: text('parent_span_id'),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  status: text('status').notNull(),
  startedAt: real('started_at').notNull(),
  endedAt: real('ended_at'),
  durationMs: real('duration_ms'),
  inputJson: text('input_json', { mode: 'json' }).$type<unknown>().notNull(),
  outputJson: text('output_json', { mode: 'json' }).$type<unknown>().notNull(),
  attributesJson: text('attributes_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  codeJson: text('code_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  usageJson: text('usage_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  tokenImpactJson: text('token_impact_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  codeFile: text('code_file'),
  codeModule: text('code_module'),
  codeFunction: text('code_function'),
  codeQualname: text('code_qualname'),
  codeLine: integer('code_line'),
  ordinal: integer('ordinal').notNull(),
}, table => ({
  runOrdinal: index('idx_spans_run_ordinal').on(table.runId, table.ordinal),
  parent: index('idx_spans_parent').on(table.runId, table.parentSpanId, table.ordinal),
  kind: index('idx_spans_kind').on(table.kind),
}))

export const usage = sqliteTable('usage', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  spanId: text('span_id').references(() => spans.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheRead: integer('cache_read'),
  cacheWrite: integer('cache_write'),
  freshInput: integer('fresh_input'),
  totalTokens: integer('total_tokens'),
  cacheRatio: real('cache_ratio'),
  cost: real('cost'),
  currency: text('currency').default('USD'),
}, table => ({ run: index('idx_usage_run').on(table.runId), span: index('idx_usage_span').on(table.spanId) }))

export const contextFragments = sqliteTable('context_fragments', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  spanId: text('span_id').references(() => spans.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  contentMarkdown: text('content_markdown').notNull().default(''),
  rawJson: text('raw_json', { mode: 'json' }).$type<unknown>(),
  tokenCount: integer('token_count'),
  sourceJson: text('source_json', { mode: 'json' }).$type<unknown>(),
  ordinal: integer('ordinal').notNull().default(0),
}, table => ({ runOrdinal: index('idx_context_run_ordinal').on(table.runId, table.ordinal), kind: index('idx_context_kind').on(table.kind) }))

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
  spanId: text('span_id').references(() => spans.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  name: text('name').notNull(),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  sourcePath: text('source_path'),
  createdAt: real('created_at').notNull(),
}, table => ({ hash: index('idx_artifact_hash').on(table.contentHash), run: index('idx_artifact_run').on(table.runId) }))

export type SessionRow = typeof sessions.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type SpanRow = typeof spans.$inferSelect

