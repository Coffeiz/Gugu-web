import { createHash, randomUUID } from 'node:crypto'
import { sql, type Kysely, type Transaction } from 'kysely'
import { CoreError, dataContext, DEFAULT_LLM_CONTEXT_TOKENS, DEFAULT_LLM_OUTPUT_TOKENS } from '../contracts/index.js'
import type { Database } from '../data/schema.js'
import { databaseTime, nowUtc } from '../data/codec.js'
import { compactContext } from '../agent/context/compaction.js'
import { createAgentCompactionPort } from '../agent/context/compaction-runtime.js'
import { MessageArea, stableJson } from '../agent/context/history/canonical-history.js'
import { loadSessionHistory, restoreHistoryForRequest } from '../agent/context/history/ordering.js'
import { formatAgentHistoryMessageTime } from '../agent/context/history/time.js'
import { readAgentPrompt } from '../agent/context/prompts.js'
import { updateBaselineSnapshot } from '../agent/context/prepare.js'
import { createSqliteAgentSessionSource, preserveSqliteSessionGoal } from '../agent/context/sqlite-source.js'
import { projectManualHistoryCompaction, type HistoryCompactionRow } from '../agent/run/history-compaction.js'
import { enqueueAgentRagRebuildInTransaction } from '../agent/rag/rebuild-worker.js'
import { ProviderRuntime } from '../agent/providers/runtime.js'
import type { ProviderConfig } from '../agent/providers/contracts.js'
import { createNodeProviderTransportFactory, desktopModelTransportOptions, type NodeProviderTransportOptions } from '../agent/providers/transport/node.js'
import { appendDesktopAgentTurn } from '../agent/sessions/desktop.js'
import { createSqlAgentPendingQueue } from '../agent/sessions/pending-queue.js'
import { isValidTimezone } from '../shared/date-time.js'

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex')

/** 摘要请求和命令回执共用会话锁，摘要提交与聊天回执原子写入。 */
export async function compactDesktopConversation(db: Kysely<Database>, ownerId: string, id: number, config: ProviderConfig,
  command: { text: string; clientId: string; queueClaim?: { key: number; token: string } },
  operation: string, cancellation: AbortSignal, resolveProxy?: NodeProviderTransportOptions['resolveProxy']) {
  const owner = dataContext(ownerId).ownerId.replaceAll('-', '')
  const identity = { ownerId, sessionId: String(id), runId: operation }
  const target = sql`user_id=${owner} AND id=${id} AND (source IS NULL OR source='web')`
  const claim = sql`${target} AND active_run_id=${operation} AND execution_state='baseline_updating'`
  const previous = await sql<{ id: number; command: string; text: string | null }>`
    SELECT m.id, m.content AS command, reply.content AS text
    FROM conversation_sessions s JOIN conversation_messages m ON m.session_id=s.id
    LEFT JOIN conversation_messages reply ON reply.session_id=s.id AND reply.conversation_seq=m.conversation_seq+1 AND reply.role='assistant'
    WHERE s.user_id=${owner} AND s.id=${id} AND (s.source IS NULL OR s.source='web')
      AND m.client_message_id=${command.clientId} AND m.run_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_run_admissions a WHERE a.session_id=s.id AND a.user_message_id=m.id)`.execute(db)
  if (previous.rows[0]) {
    if (previous.rows[0].command !== command.text || previous.rows[0].text === null)
      throw new CoreError('conflict', '消息标识已被使用')
    return { text: previous.rows[0].text, userMessageId: previous.rows[0].id }
  }
  async function record(tx: Transaction<Database>, text: string) {
    const held = await sql`SELECT id FROM conversation_sessions WHERE ${claim}`.execute(tx)
    if (!held.rows.length) throw new CoreError('conflict', '会话历史已变化')
    if (command.queueClaim)
      await createSqlAgentPendingQueue(db, 'sqlite', {}).consumeClaim(tx, ownerId, id, command.queueClaim.key, command.queueClaim.token)
    const saved = await appendDesktopAgentTurn(tx, ownerId, id, command.text, text, command.clientId)
    return { text, userMessageId: saved.userMessageId! }
  }
  const held = await sql`UPDATE conversation_sessions SET active_run_id=${operation},execution_state='baseline_updating'
    WHERE ${target} AND active_run_id IS NULL AND execution_state='idle' RETURNING id`.execute(db)
  if (!held.rows.length) throw new CoreError('busy', '当前会话仍在处理中或不存在')
  const source = createSqliteAgentSessionSource(db)
  const modelIdentity = digest([config.provider, config.api_format, config.base_url, config.model])
  const accessScopeHash = digest(identity)
  const systemPrompt = '请根据给定历史整理当前会话上下文。'
  let provider: ProviderRuntime | undefined
  try {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(120_000)])
    const snapshot = await source.readSnapshot(identity, signal)
    if (!snapshot) throw new CoreError('not_found', '会话不存在')
    const baselineSeq = snapshot.baselineMessageSeq ?? 0
    async function rows(connection: Kysely<Database>) {
      const result = await sql<HistoryCompactionRow>`SELECT CAST(id AS TEXT) AS id,role,content,content_json,
        coalesce(history_anchor_seq,conversation_seq) AS effective FROM conversation_messages
        WHERE session_id=${id} AND role<>'summary' AND coalesce(history_anchor_seq,conversation_seq)>${baselineSeq}
        ORDER BY effective,(history_anchor_seq IS NULL),conversation_seq`.execute(connection)
      return result.rows.map(row => ({ ...row, content_json: typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json }))
    }
    const before = await rows(db)
    const history = await loadSessionHistory(identity, source.historyReader, signal, { loadImages: false })
    const zone = snapshot.context?.user_tz
    const userTimezone = typeof zone === 'string' && isValidTimezone(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone
    const area = new MessageArea({ digest, nextId: randomUUID }, history.rows.flatMap(row => {
      const value = restoreHistoryForRequest(row, { groupChat: false, userTimezone, formatMessageTime: formatAgentHistoryMessageTime })
      return value ? [value] : []
    }))
    provider = new ProviderRuntime({ digest, nextId: randomUUID,
      resolve: async () => ({ modelIdentity, accessScopeHash, config, systemPrompt }),
      references: { dehydrate: async entry => entry.message, hydrate: async entry => entry.message },
      async prepareRequest() { throw new Error('手动压缩不发送普通对话请求') },
      transportFactory: createNodeProviderTransportFactory(desktopModelTransportOptions(config, resolveProxy)),
    })
    const port = createAgentCompactionPort({ identity, provider, modelIdentity, stableSystem: systemPrompt,
      scope: accessScopeHash, scopeRevision: accessScopeHash, contextTokens: typeof config.context_tokens === 'number' ? config.context_tokens : DEFAULT_LLM_CONTEXT_TOKENS,
      maxOutputTokens: config.max_tokens ?? DEFAULT_LLM_OUTPUT_TOKENS, instruction: readAgentPrompt('compress_conv.md'),
      digest, nextId: randomUUID, async loadTools() { return [] }, diagnostic() {},
    })
    const result = await compactContext(area, port, { modelIdentity, signal })
    const text = result.changed ? '上下文已经整理好了，旧对话已压缩为摘要。' : '当前历史还不够长，暂时无需整理上下文。'
    return await db.transaction().execute(async tx => {
      signal.throwIfAborted()
      const { rows: [session] } = await sql<{ last_message_seq: number }>`SELECT last_message_seq FROM conversation_sessions
        WHERE ${claim} AND baseline_message_seq=${baselineSeq} AND context_epoch=${snapshot.contextEpoch}
          AND snapshot_hash IS ${snapshot.snapshotHash} AND baseline_message_hash IS ${history.baselineIdentity?.baselineHash ?? null}`.execute(tx)
      if (!session || !Number.isSafeInteger(session.last_message_seq + 1)) throw new CoreError('conflict', '会话历史已变化')
      if (!result.changed) return record(tx, text)
      const { summary, baseline, hash } = projectManualHistoryCompaction(result, before, await rows(tx), baselineSeq)!
      const next = snapshot.context?.system_prompt ? updateBaselineSnapshot(snapshot, [{ role: 'summary', content: summary }],
        { digest, nextId: randomUUID, now: Date.now }, { baselineMessageSeq: baseline }) : null
      const context = next ? await preserveSqliteSessionGoal(tx, owner, id, next.context) : snapshot.context
      const at = databaseTime(nowUtc(), 'sqlite')
      await sql`DELETE FROM conversation_messages WHERE session_id=${id} AND role='summary'`.execute(tx)
      await sql`INSERT INTO conversation_messages(session_id,conversation_seq,role,content,covers_until_seq,created_at)
        VALUES(${id},${session.last_message_seq + 1},'summary',${summary},${baseline},${at})`.execute(tx)
      await sql`UPDATE conversation_sessions SET last_message_seq=last_message_seq+1,baseline_message_seq=${baseline},
        baseline_message_hash=${hash},session_context=${context === null ? null : JSON.stringify(context)},
        context_epoch=${next?.contextEpoch ?? snapshot.contextEpoch},snapshot_hash=${next?.snapshotHash ?? null},
        snapshot_expires_at=${next?.snapshotExpiresAt ? databaseTime(new Date(next.snapshotExpiresAt).toISOString(), 'sqlite') : null}
        WHERE ${claim}`.execute(tx)
      const reply = await record(tx, text)
      await enqueueAgentRagRebuildInTransaction(tx, 'sqlite', ownerId, 'conversation')
      return reply
    })
  } catch (error) {
    if (cancellation.aborted || error instanceof CoreError) throw error
    const text = '这次压缩没有完成，请稍后再试。'
    return await db.transaction().execute(tx => record(tx, text))
  } finally {
    try { await provider?.close() }
    finally { await sql`UPDATE conversation_sessions SET active_run_id=NULL,execution_state='idle' WHERE ${claim}`.execute(db) }
  }
}
