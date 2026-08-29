import { createHash } from 'node:crypto'
import { and, asc, count, desc, eq, lt, sql } from 'drizzle-orm'
import { TraceRunInputSchema, type TokenUsage, type TraceRunInput } from '@loopscope/contracts'
import { artifacts, contextFragments, openDatabase, runs, sessions, spans, usage } from '@loopscope/db'

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value
  const obj = record(value)
  for (const key of ['content', 'included', 'system_prompt', 'text']) {
    if (typeof obj[key] === 'string') return obj[key] as string
  }
  return ''
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function tokenContribution(span: TraceRunInput['spans'][number]): number | undefined {
  const impact = record(span.token_impact)
  for (const key of ['included_tokens', 'source_tokens', 'estimated_input_tokens', 'prompt_tokens_estimate', 'result_tokens']) {
    const value = numeric(impact[key])
    if (value !== undefined) return Math.round(value)
  }
  return undefined
}

function normalizeUsage(value: unknown): TokenUsage {
  const u = record(value)
  const input = numeric(u.input)
  const output = numeric(u.output)
  const cacheRead = numeric(u.cache_read)
  const cacheWrite = numeric(u.cache_write)
  const freshInput = numeric(u.fresh_input) ?? (input !== undefined ? Math.max(input - (cacheRead ?? 0), 0) : undefined)
  const total = numeric(u.total) ?? ((input !== undefined || output !== undefined) ? (input ?? 0) + (output ?? 0) : undefined)
  const cacheRatio = numeric(u.cache_ratio) ?? (input ? (cacheRead ?? 0) / input : undefined)
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, fresh_input: freshInput, total, cache_ratio: cacheRatio }
}

function usageValues(id: string, runId: string, spanId: string | null, scope: string, value: unknown) {
  const u = normalizeUsage(value)
  if (![u.input, u.output, u.cache_read, u.cache_write, u.total].some(v => v !== undefined)) return null
  return {
    id, runId, spanId, scope,
    inputTokens: u.input == null ? null : Math.round(u.input),
    outputTokens: u.output == null ? null : Math.round(u.output),
    cacheRead: u.cache_read == null ? null : Math.round(u.cache_read),
    cacheWrite: u.cache_write == null ? null : Math.round(u.cache_write),
    freshInput: u.fresh_input == null ? null : Math.round(u.fresh_input),
    totalTokens: u.total == null ? null : Math.round(u.total),
    cacheRatio: u.cache_ratio ?? null,
    cost: null,
    currency: 'USD',
  }
}

const CONTEXT_KINDS = new Set(['context', 'file', 'memory', 'database', 'history', 'cache', 'rag'])

export class TraceStore {
  readonly connection

  constructor(databasePath: string) {
    this.connection = openDatabase(databasePath)
  }

  close() { this.connection.sqlite.close() }

  ingestRun(raw: unknown) {
    const payload = TraceRunInputSchema.parse(raw)
    const { db } = this.connection
    const inputObj = record(payload.input)
    const titleSource = String(inputObj.user_message ?? payload.title ?? '').trim()
    const title = titleSource.slice(0, 48) || `Session ${payload.external_session_id || payload.session_key}`
    const ended = payload.ended_at ?? null

    db.transaction(tx => {
      tx.insert(sessions).values({
        sessionKey: payload.session_key,
        externalSessionId: payload.external_session_id,
        source: payload.source,
        title,
        createdAt: payload.started_at,
        updatedAt: ended ?? payload.started_at,
      }).onConflictDoUpdate({
        target: sessions.sessionKey,
        set: {
          externalSessionId: payload.external_session_id,
          source: payload.source,
          updatedAt: ended ?? payload.started_at,
          title: sql`CASE WHEN ${sessions.title} LIKE 'Session %' OR ${sessions.title} = 'Untitled session' THEN excluded.title ELSE ${sessions.title} END`,
        },
      }).run()

      tx.insert(runs).values({
        id: payload.id,
        sessionKey: payload.session_key,
        traceId: payload.trace_id,
        status: payload.status,
        startedAt: payload.started_at,
        endedAt: ended,
        durationMs: payload.duration_ms ?? null,
        inputJson: payload.input,
        outputJson: payload.output,
        attributesJson: payload.attributes,
        usageJson: payload.usage,
        rawJson: payload,
      }).onConflictDoUpdate({
        target: runs.id,
        set: {
          status: payload.status,
          endedAt: ended,
          durationMs: payload.duration_ms ?? null,
          inputJson: payload.input,
          outputJson: payload.output,
          attributesJson: payload.attributes,
          usageJson: payload.usage,
          rawJson: payload,
        },
      }).run()

      tx.delete(contextFragments).where(eq(contextFragments.runId, payload.id)).run()
      tx.delete(artifacts).where(eq(artifacts.runId, payload.id)).run()
      tx.delete(usage).where(eq(usage.runId, payload.id)).run()
      tx.delete(spans).where(eq(spans.runId, payload.id)).run()

      payload.spans.forEach((span, ordinal) => {
        const code = record(span.code)
        tx.insert(spans).values({
          id: span.id,
          runId: payload.id,
          parentSpanId: span.parent_span_id ?? null,
          kind: span.kind,
          name: span.name,
          status: span.status,
          startedAt: span.started_at,
          endedAt: span.ended_at ?? null,
          durationMs: span.duration_ms ?? null,
          inputJson: span.input,
          outputJson: span.output,
          attributesJson: span.attributes,
          codeJson: code,
          usageJson: record(span.usage),
          tokenImpactJson: record(span.token_impact),
          codeFile: typeof code.file === 'string' ? code.file : null,
          codeModule: typeof code.module === 'string' ? code.module : null,
          codeFunction: typeof code.function === 'string' ? code.function : null,
          codeQualname: typeof code.qualname === 'string' ? code.qualname : null,
          codeLine: numeric(code.line) == null ? null : Math.round(numeric(code.line)!),
          ordinal,
        }).run()

        const spanUsage = usageValues(`${payload.id}:span:${span.id}`, payload.id, span.id, 'span', span.usage)
        if (spanUsage) tx.insert(usage).values(spanUsage).run()

        if (CONTEXT_KINDS.has(span.kind)) {
          const content = textContent(span.output)
          const attrs = record(span.attributes)
          tx.insert(contextFragments).values({
            id: `${payload.id}:context:${ordinal}`,
            runId: payload.id,
            spanId: span.id,
            kind: span.kind,
            title: span.name,
            contentMarkdown: content,
            rawJson: span.output,
            tokenCount: tokenContribution(span) ?? null,
            sourceJson: { code, attributes: attrs },
            ordinal,
          }).run()

          if (span.kind === 'file' && content) {
            const sourcePath = typeof attrs.path === 'string' ? attrs.path : null
            const hash = createHash('sha256').update(content).digest('hex')
            tx.insert(artifacts).values({
              id: `${payload.id}:artifact:${ordinal}`,
              runId: payload.id,
              spanId: span.id,
              type: 'prompt_file',
              name: span.name,
              content,
              contentHash: hash,
              sourcePath,
              createdAt: span.ended_at ?? span.started_at,
            }).run()
          }
        }
      })

      const runUsage = usageValues(`${payload.id}:run`, payload.id, null, 'run', payload.usage)
      if (runUsage) tx.insert(usage).values(runUsage).run()
    })

    return { ok: true, run_id: payload.id, spans: payload.spans.length }
  }

  listSessions() {
    const rows = this.connection.db
      .select({
        sessionKey: sessions.sessionKey,
        externalSessionId: sessions.externalSessionId,
        source: sessions.source,
        title: sessions.title,
        createdAt: sessions.createdAt,
        updatedAt: sessions.updatedAt,
        runCount: count(runs.id),
        errorCount: sql<number>`coalesce(sum(case when ${runs.status} = 'error' then 1 else 0 end), 0)`,
      })
      .from(sessions)
      .leftJoin(runs, eq(runs.sessionKey, sessions.sessionKey))
      .groupBy(sessions.sessionKey)
      .orderBy(sql`${sessions.updatedAt} desc`)
      .all()
    return rows.map(row => ({
      session_key: row.sessionKey,
      external_session_id: row.externalSessionId ?? '',
      source: row.source,
      title: row.title,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      run_count: Number(row.runCount ?? 0),
      error_count: Number(row.errorCount ?? 0),
    }))
  }

  listRuns(sessionKey: string, options: { limit?: number; before?: number } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100)
    const condition = options.before == null
      ? eq(runs.sessionKey, sessionKey)
      : and(eq(runs.sessionKey, sessionKey), lt(runs.startedAt, options.before))
    const rows = this.connection.db.select().from(runs).where(condition)
      .orderBy(desc(runs.startedAt)).limit(limit).all()
    return rows.reverse().map(row => this.runApi(row))
  }

  getRun(runId: string, includeSpans = true) {
    const run = this.connection.db.select().from(runs).where(eq(runs.id, runId)).get()
    if (!run) return null
    if (!includeSpans) return this.runApi(run)
    const spanRows = this.connection.db.select().from(spans).where(eq(spans.runId, runId)).orderBy(asc(spans.ordinal)).all()
    return { ...this.runApi(run), spans: spanRows.map(row => this.spanApi(row)) }
  }

  listSpans(runId: string, options: { limit?: number; offset?: number } = {}) {
    const exists = this.connection.db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get()
    if (!exists) return null
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 200)
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0)
    const rows = this.connection.db.select().from(spans).where(eq(spans.runId, runId))
      .orderBy(asc(spans.ordinal)).limit(limit + 1).offset(offset).all()
    return {
      items: rows.slice(0, limit).map(row => this.spanApi(row)),
      offset,
      limit,
      hasMore: rows.length > limit,
    }
  }

  listContext(runId: string) {
    return this.connection.db.select().from(contextFragments).where(eq(contextFragments.runId, runId)).orderBy(asc(contextFragments.ordinal)).all().map(row => ({
      id: row.id, run_id: row.runId, span_id: row.spanId, kind: row.kind, title: row.title,
      content_markdown: row.contentMarkdown, raw: row.rawJson, token_count: row.tokenCount,
      source: row.sourceJson, ordinal: row.ordinal,
    }))
  }

  listUsage(runId: string) {
    return this.connection.db.select().from(usage).where(eq(usage.runId, runId)).all().map(row => ({
      id: row.id, run_id: row.runId, span_id: row.spanId, scope: row.scope,
      input: row.inputTokens, output: row.outputTokens, cache_read: row.cacheRead,
      cache_write: row.cacheWrite, fresh_input: row.freshInput, total: row.totalTokens,
      cache_ratio: row.cacheRatio, cost: row.cost, currency: row.currency,
    }))
  }

  private runApi(row: typeof runs.$inferSelect) {
    return {
      id: row.id,
      session_key: row.sessionKey,
      trace_id: row.traceId ?? '',
      status: row.status,
      started_at: row.startedAt,
      ended_at: row.endedAt,
      duration_ms: row.durationMs,
      input: row.inputJson,
      output: row.outputJson,
      attributes: row.attributesJson,
      usage: row.usageJson,
    }
  }

  private spanApi(row: typeof spans.$inferSelect) {
    const storedCode = record(row.codeJson)
    const code = {
      ...storedCode,
      ...(row.codeFile ? { file: row.codeFile } : {}),
      ...(row.codeModule ? { module: row.codeModule } : {}),
      ...(row.codeFunction ? { function: row.codeFunction } : {}),
      ...(row.codeQualname ? { qualname: row.codeQualname } : {}),
      ...(row.codeLine != null ? { line: row.codeLine } : {}),
    }
    return {
      id: row.id,
      run_id: row.runId,
      parent_span_id: row.parentSpanId,
      kind: row.kind,
      name: row.name,
      status: row.status,
      started_at: row.startedAt,
      ended_at: row.endedAt,
      duration_ms: row.durationMs,
      input: row.inputJson,
      output: row.outputJson,
      attributes: row.attributesJson,
      code,
      usage: row.usageJson,
      token_impact: row.tokenImpactJson,
      ordinal: row.ordinal,
    }
  }
}
